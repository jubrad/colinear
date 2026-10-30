//! What a `ColiUser` becomes (design/multi-user/operator.md, "ColiUser").
//!
//! [`desired`] is a pure function from the user, the org and the operator's
//! settings to every object that user needs, so what the cluster will hold
//! is testable without one. The tests below assert the security properties
//! directly: the daemon's reach, the workspace's lack of a token, the pod's
//! privileges, and what the network lets through.

use std::collections::BTreeMap;

use coli_crds::{ColiOrgSpec, ColiUser};
use k8s_openapi::ByteString;
use k8s_openapi::api::apps::v1::{StatefulSet, StatefulSetSpec};
use k8s_openapi::api::core::v1::{
    Capabilities, ConfigMap, ConfigMapVolumeSource, Container, ContainerPort, EmptyDirVolumeSource,
    EnvVar, EnvVarSource, Namespace, ObjectFieldSelector, PersistentVolumeClaim,
    PersistentVolumeClaimSpec, PodSecurityContext, PodSpec, PodTemplateSpec, ResourceQuota,
    ResourceQuotaSpec, ResourceRequirements, SeccompProfile, Secret, SecretVolumeSource,
    SecurityContext, Service, ServiceAccount, ServicePort, ServiceSpec, Volume, VolumeMount,
    VolumeResourceRequirements,
};
use k8s_openapi::api::networking::v1::{
    IPBlock, NetworkPolicy, NetworkPolicyEgressRule, NetworkPolicyIngressRule, NetworkPolicyPeer,
    NetworkPolicyPort, NetworkPolicySpec,
};
use k8s_openapi::api::rbac::v1::{
    ClusterRoleBinding, PolicyRule, Role, RoleBinding, RoleRef, Subject,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta, OwnerReference};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::Resource;

/// The daemon's two listeners: clients (the gateway) on one, its runners on the other,
/// so `NetworkPolicy` can let each in to only its own.
pub const CLIENT_PORT: i32 = 7419;
pub const RUNNER_PORT: i32 = 7420;

pub const DAEMON: &str = "coli-daemon";
pub const WORKSPACE: &str = "coli-workspace";
pub const ORG_CONFIG: &str = "coli-org";
pub const LINEAR_OAUTH: &str = "coli-linear-oauth";
pub const TOKENREVIEW_ROLE: &str = "coli-tokenreview";

pub const ROLE_LABEL: &str = "colinear.dev/role";
pub const USER_LABEL: &str = "colinear.dev/user";
const MANAGED_BY: (&str, &str) = ("app.kubernetes.io/managed-by", "coli-operator");

/// Inside the daemon's pod.
pub const STATE_DIR: &str = "/state";
pub const ORG_CONFIG_DIR: &str = "/etc/colinear";
pub const LINEAR_OAUTH_DIR: &str = "/etc/colinear/linear-oauth";

/// What the operator was installed with, rather than anything a user wrote.
#[derive(Clone, Debug)]
pub struct Settings {
    /// where the operator and gateway run, and the org's Secrets are
    pub system_namespace: String,
    pub daemon_image: String,
    pub daemon_cpu: String,
    pub daemon_memory: String,
    /// the daemon's own volume: its state, the vault, transcripts it keeps
    pub daemon_disk: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            system_namespace: "coli-system".into(),
            daemon_image: "ghcr.io/jubrad/colinear:latest".into(),
            daemon_cpu: "100m".into(),
            daemon_memory: "512Mi".into(),
            daemon_disk: "5Gi".into(),
        }
    }
}

/// Every object one user needs. Typed fields rather than a list, so applying
/// each is checked against its own API at compile time.
#[derive(Clone, Debug)]
pub struct Desired {
    pub namespace: Namespace,
    pub daemon_account: ServiceAccount,
    pub workspace_account: ServiceAccount,
    pub daemon_role: Role,
    pub daemon_binding: RoleBinding,
    pub tokenreview_binding: ClusterRoleBinding,
    pub daemon: StatefulSet,
    pub service: Service,
    pub network: Vec<NetworkPolicy>,
    pub quota: ResourceQuota,
    pub org_config: ConfigMap,
    /// absent until the org has set its Linear OAuth app up
    pub linear_oauth: Option<Secret>,
}

/// `coli-u-<name>`, or why this user can't have one: a namespace name is a
/// DNS label, and a `ColiUser` name may be longer than one allows.
pub fn namespace_for(user: &ColiUser) -> Result<String, String> {
    let name = user.metadata.name.as_deref().unwrap_or_default();
    let ns = format!("coli-u-{name}");
    let label_ok = ns.len() <= 63
        && ns
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !ns.ends_with('-');
    if label_ok {
        Ok(ns)
    } else {
        Err(format!(
            "{ns:?} isn't a valid namespace name: a user's name must be lowercase letters, digits and \
             '-', at most 56 characters"
        ))
    }
}

/// The address the gateway and the user's runners dial.
pub fn daemon_service(ns: &str) -> String {
    format!("{DAEMON}.{ns}.svc:{CLIENT_PORT}")
}

/// Everything `user` needs. `linear_oauth` is the org's Secret's data, if it has one.
pub fn desired(
    user: &ColiUser,
    org: Option<&ColiOrgSpec>,
    linear_oauth: Option<&BTreeMap<String, ByteString>>,
    settings: &Settings,
) -> Result<Desired, String> {
    let ns = namespace_for(user)?;
    let name = user.metadata.name.clone().unwrap_or_default();
    let owner = owner(user)?;
    let labels = BTreeMap::from([
        (USER_LABEL.to_string(), name.clone()),
        (MANAGED_BY.0.to_string(), MANAGED_BY.1.to_string()),
    ]);
    let meta = |object: &str, extra: &[(&str, &str)]| {
        let mut labels = labels.clone();
        labels.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        ObjectMeta {
            name: Some(object.into()),
            namespace: Some(ns.clone()),
            labels: Some(labels),
            owner_references: Some(vec![owner.clone()]),
            ..Default::default()
        }
    };

    let namespace = Namespace {
        metadata: ObjectMeta {
            namespace: None,
            ..meta(&ns, &[])
        },
        ..Default::default()
    };

    let daemon_account = ServiceAccount {
        metadata: meta(DAEMON, &[]),
        ..Default::default()
    };
    // a workspace pod has no Kubernetes API token: the agent can read anything
    // its runner can, so the runner holds nothing the API would accept
    let workspace_account = ServiceAccount {
        metadata: meta(WORKSPACE, &[]),
        automount_service_account_token: Some(false),
        ..Default::default()
    };

    let daemon_role = Role {
        metadata: meta(DAEMON, &[]),
        rules: Some(daemon_rules()),
    };
    let daemon_binding = RoleBinding {
        metadata: meta(DAEMON, &[]),
        role_ref: RoleRef {
            api_group: "rbac.authorization.k8s.io".into(),
            kind: "Role".into(),
            name: DAEMON.into(),
        },
        subjects: Some(vec![daemon_subject(&ns)]),
    };
    // cluster-scoped, so named for the namespace; it grants creating TokenReviews and nothing else
    let tokenreview_binding = ClusterRoleBinding {
        metadata: ObjectMeta {
            name: Some(format!("{TOKENREVIEW_ROLE}-{ns}")),
            namespace: None,
            ..meta("", &[])
        },
        role_ref: RoleRef {
            api_group: "rbac.authorization.k8s.io".into(),
            kind: "ClusterRole".into(),
            name: TOKENREVIEW_ROLE.into(),
        },
        subjects: Some(vec![daemon_subject(&ns)]),
    };

    let daemon_labels = [(ROLE_LABEL, "daemon")];
    let daemon = StatefulSet {
        metadata: meta(DAEMON, &daemon_labels),
        spec: Some(StatefulSetSpec {
            // disabled: stopped, with its volume kept for when it comes back
            replicas: Some(if user.spec.enabled { 1 } else { 0 }),
            service_name: Some(DAEMON.into()),
            selector: LabelSelector {
                match_labels: Some(selector(&daemon_labels)),
                ..Default::default()
            },
            template: PodTemplateSpec {
                metadata: Some(ObjectMeta {
                    labels: Some({
                        let mut l = labels.clone();
                        l.extend(selector(&daemon_labels));
                        l
                    }),
                    ..Default::default()
                }),
                spec: Some(daemon_pod(settings)),
            },
            volume_claim_templates: Some(vec![PersistentVolumeClaim {
                metadata: ObjectMeta {
                    name: Some("state".into()),
                    ..Default::default()
                },
                spec: Some(PersistentVolumeClaimSpec {
                    access_modes: Some(vec!["ReadWriteOnce".into()]),
                    resources: Some(VolumeResourceRequirements {
                        requests: Some(BTreeMap::from([(
                            "storage".into(),
                            Quantity(settings.daemon_disk.clone()),
                        )])),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            }]),
            ..Default::default()
        }),
        ..Default::default()
    };

    let service = Service {
        metadata: meta(DAEMON, &[]),
        spec: Some(ServiceSpec {
            selector: Some(selector(&daemon_labels)),
            ports: Some(vec![
                ServicePort {
                    name: Some("client".into()),
                    port: CLIENT_PORT,
                    ..Default::default()
                },
                ServicePort {
                    name: Some("runner".into()),
                    port: RUNNER_PORT,
                    ..Default::default()
                },
            ]),
            ..Default::default()
        }),
        ..Default::default()
    };

    let quota = ResourceQuota {
        metadata: meta("coli-limits", &[]),
        spec: Some(ResourceQuotaSpec {
            hard: Some(quota(org)),
            ..Default::default()
        }),
        ..Default::default()
    };

    let org_config = ConfigMap {
        metadata: meta(ORG_CONFIG, &[]),
        data: Some(BTreeMap::from([(
            "org.json".into(),
            org.map(|o| serde_json::to_string_pretty(o).expect("an org spec always serializes"))
                .unwrap_or_else(|| "{}".into()),
        )])),
        ..Default::default()
    };

    // only the keys that identify the app: the copy can't carry anything else the org's Secret holds
    let linear_oauth = linear_oauth.map(|data| Secret {
        metadata: meta(LINEAR_OAUTH, &[]),
        data: Some(
            data.iter()
                .filter(|(k, _)| matches!(k.as_str(), "client-id" | "client-secret"))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ),
        type_: Some("Opaque".into()),
        ..Default::default()
    });

    Ok(Desired {
        network: network_policies(settings, &meta),
        namespace,
        daemon_account,
        workspace_account,
        daemon_role,
        daemon_binding,
        tokenreview_binding,
        daemon,
        service,
        quota,
        org_config,
        linear_oauth,
    })
}

/// The daemon's whole reach: its own workspaces and shares, and reading pods
/// to see how they are. operator.md, "RBAC and admission".
fn daemon_rules() -> Vec<PolicyRule> {
    let verbs = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    vec![
        PolicyRule {
            api_groups: Some(vec!["colinear.dev".into()]),
            resources: Some(vec!["coliworkspaces".into(), "colishares".into()]),
            verbs: verbs(&["get", "list", "watch", "create", "patch", "delete"]),
            ..Default::default()
        },
        PolicyRule {
            api_groups: Some(vec!["".into()]),
            resources: Some(vec!["pods".into()]),
            verbs: verbs(&["get", "list", "watch"]),
            ..Default::default()
        },
    ]
}

fn daemon_subject(ns: &str) -> Subject {
    Subject {
        kind: "ServiceAccount".into(),
        name: DAEMON.into(),
        namespace: Some(ns.into()),
        ..Default::default()
    }
}

fn daemon_pod(settings: &Settings) -> PodSpec {
    let env = |name: &str, value: &str| EnvVar {
        name: name.into(),
        value: Some(value.into()),
        ..Default::default()
    };
    let mount = |name: &str, path: &str, read_only: bool| VolumeMount {
        name: name.into(),
        mount_path: path.into(),
        read_only: Some(read_only),
        ..Default::default()
    };
    let memory = |name: &str| Volume {
        name: name.into(),
        empty_dir: Some(EmptyDirVolumeSource::default()),
        ..Default::default()
    };
    PodSpec {
        service_account_name: Some(DAEMON.into()),
        // the daemon does talk to the API: it writes its ColiWorkspaces and checks runners' tokens
        automount_service_account_token: Some(true),
        security_context: Some(PodSecurityContext {
            run_as_non_root: Some(true),
            run_as_user: Some(1000),
            run_as_group: Some(1000),
            fs_group: Some(1000),
            seccomp_profile: Some(SeccompProfile {
                type_: "RuntimeDefault".into(),
                ..Default::default()
            }),
            ..Default::default()
        }),
        containers: vec![Container {
            name: "daemon".into(),
            image: Some(settings.daemon_image.clone()),
            command: Some(vec!["coli".into(), "daemon".into()]),
            env: Some(vec![
                env("COLINEAR_STATE_DIR", STATE_DIR),
                env("COLINEAR_ORG_CONFIG", &format!("{ORG_CONFIG_DIR}/org.json")),
                env("COLINEAR_LINEAR_OAUTH_DIR", LINEAR_OAUTH_DIR),
                env("COLINEAR_CLIENT_PORT", &CLIENT_PORT.to_string()),
                env("COLINEAR_RUNNER_PORT", &RUNNER_PORT.to_string()),
                env("HOME", "/home/coli"),
                EnvVar {
                    name: "COLINEAR_NAMESPACE".into(),
                    value_from: Some(EnvVarSource {
                        field_ref: Some(ObjectFieldSelector {
                            field_path: "metadata.namespace".into(),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            ]),
            ports: Some(vec![
                ContainerPort {
                    name: Some("client".into()),
                    container_port: CLIENT_PORT,
                    ..Default::default()
                },
                ContainerPort {
                    name: Some("runner".into()),
                    container_port: RUNNER_PORT,
                    ..Default::default()
                },
            ]),
            resources: Some(ResourceRequirements {
                requests: Some(BTreeMap::from([
                    ("cpu".into(), Quantity(settings.daemon_cpu.clone())),
                    ("memory".into(), Quantity(settings.daemon_memory.clone())),
                ])),
                limits: Some(BTreeMap::from([(
                    "memory".into(),
                    Quantity(settings.daemon_memory.clone()),
                )])),
                ..Default::default()
            }),
            security_context: Some(locked_down()),
            volume_mounts: Some(vec![
                mount("state", STATE_DIR, false),
                mount("org", ORG_CONFIG_DIR, true),
                mount("linear-oauth", LINEAR_OAUTH_DIR, true),
                mount("home", "/home/coli", false),
                mount("tmp", "/tmp", false),
            ]),
            ..Default::default()
        }],
        volumes: Some(vec![
            Volume {
                name: "org".into(),
                config_map: Some(ConfigMapVolumeSource {
                    name: ORG_CONFIG.into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
            Volume {
                name: "linear-oauth".into(),
                secret: Some(SecretVolumeSource {
                    secret_name: Some(LINEAR_OAUTH.into()),
                    // an org without Linear OAuth yet still gets a daemon
                    optional: Some(true),
                    ..Default::default()
                }),
                ..Default::default()
            },
            memory("home"),
            memory("tmp"),
        ]),
        ..Default::default()
    }
}

/// No root, no privilege, no capability, nothing writable but the volumes it's given.
pub fn locked_down() -> SecurityContext {
    SecurityContext {
        allow_privilege_escalation: Some(false),
        privileged: Some(false),
        read_only_root_filesystem: Some(true),
        run_as_non_root: Some(true),
        capabilities: Some(Capabilities {
            drop: Some(vec!["ALL".into()]),
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn quota(org: Option<&ColiOrgSpec>) -> BTreeMap<String, Quantity> {
    let limits = org.and_then(|o| o.limits.as_ref());
    // the daemon is a pod too, and a user without a limit set still gets one
    let awake = limits.and_then(|l| l.awake_workspaces).unwrap_or(10);
    let mut hard = BTreeMap::from([("pods".to_string(), Quantity((awake + 1).to_string()))]);
    let mut set = |key: &str, value: Option<&String>| {
        if let Some(v) = value {
            hard.insert(key.into(), Quantity(v.clone()));
        }
    };
    set("requests.cpu", limits.and_then(|l| l.cpu.as_ref()));
    set("requests.memory", limits.and_then(|l| l.memory.as_ref()));
    set("requests.storage", limits.and_then(|l| l.storage.as_ref()));
    hard
}

/// Never reachable from a workspace: other pods and services, the Kubernetes
/// API, and the cloud's metadata endpoint (169.254.169.254, which hands out
/// the node's credentials).
const PRIVATE_V4: [&str; 5] = [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "100.64.0.0/10",
    "169.254.0.0/16",
];
const PRIVATE_V6: [&str; 2] = ["fc00::/7", "fe80::/10"];

/// operator.md, "Network". Deny by default, then:
/// - the daemon accepts the gateway on the client port, and this namespace's workspaces on the runner port
/// - a workspace reaches its daemon's runner port, DNS, and the internet, and nothing private
/// - the daemon reaches DNS, the API and the internet; other users' daemons and workspaces refuse it on their side
fn network_policies(
    settings: &Settings,
    meta: &dyn Fn(&str, &[(&str, &str)]) -> ObjectMeta,
) -> Vec<NetworkPolicy> {
    let pods = |role: &str| LabelSelector {
        match_labels: Some(selector(&[(ROLE_LABEL, role)])),
        ..Default::default()
    };
    let port = |p: i32, protocol: &str| NetworkPolicyPort {
        port: Some(IntOrString::Int(p)),
        protocol: Some(protocol.into()),
        ..Default::default()
    };
    let dns = NetworkPolicyEgressRule {
        to: Some(vec![NetworkPolicyPeer {
            namespace_selector: Some(LabelSelector {
                match_labels: Some(selector(&[("kubernetes.io/metadata.name", "kube-system")])),
                ..Default::default()
            }),
            ..Default::default()
        }]),
        ports: Some(vec![port(53, "UDP"), port(53, "TCP")]),
    };
    let internet = |except_private: bool| NetworkPolicyEgressRule {
        to: Some(
            [("0.0.0.0/0", &PRIVATE_V4[..]), ("::/0", &PRIVATE_V6[..])]
                .iter()
                .map(|(cidr, private)| NetworkPolicyPeer {
                    ip_block: Some(IPBlock {
                        cidr: cidr.to_string(),
                        except: except_private
                            .then(|| private.iter().map(|s| s.to_string()).collect()),
                    }),
                    ..Default::default()
                })
                .collect(),
        ),
        ports: None,
    };
    let policy = |name: &str, spec: NetworkPolicySpec| NetworkPolicy {
        metadata: meta(name, &[]),
        spec: Some(spec),
    };
    let both = Some(vec!["Ingress".to_string(), "Egress".to_string()]);

    vec![
        // every pod here, including any added later: nothing in, nothing out, unless a rule below says so
        policy(
            "default-deny",
            NetworkPolicySpec {
                pod_selector: Some(LabelSelector::default()),
                policy_types: both.clone(),
                ..Default::default()
            },
        ),
        policy(
            DAEMON,
            NetworkPolicySpec {
                pod_selector: Some(pods("daemon")),
                policy_types: both.clone(),
                ingress: Some(vec![
                    NetworkPolicyIngressRule {
                        from: Some(vec![NetworkPolicyPeer {
                            namespace_selector: Some(LabelSelector {
                                match_labels: Some(selector(&[(
                                    "kubernetes.io/metadata.name",
                                    &settings.system_namespace,
                                )])),
                                ..Default::default()
                            }),
                            pod_selector: Some(LabelSelector {
                                match_labels: Some(selector(&[(
                                    "app.kubernetes.io/name",
                                    "coli-gateway",
                                )])),
                                ..Default::default()
                            }),
                            ..Default::default()
                        }]),
                        ports: Some(vec![port(CLIENT_PORT, "TCP")]),
                    },
                    NetworkPolicyIngressRule {
                        from: Some(vec![NetworkPolicyPeer {
                            pod_selector: Some(pods("workspace")),
                            ..Default::default()
                        }]),
                        ports: Some(vec![port(RUNNER_PORT, "TCP")]),
                    },
                ]),
                // the API server isn't a pod a selector can name; it's an address like any other
                egress: Some(vec![dns.clone(), internet(false)]),
            },
        ),
        policy(
            WORKSPACE,
            NetworkPolicySpec {
                pod_selector: Some(pods("workspace")),
                policy_types: both,
                ingress: Some(vec![]),
                egress: Some(vec![
                    NetworkPolicyEgressRule {
                        to: Some(vec![NetworkPolicyPeer {
                            pod_selector: Some(pods("daemon")),
                            ..Default::default()
                        }]),
                        ports: Some(vec![port(RUNNER_PORT, "TCP")]),
                    },
                    dns,
                    internet(true),
                ]),
            },
        ),
    ]
}

fn selector(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// Everything a user has is owned by their `ColiUser`, so deleting it deletes
/// the lot: the namespace (and so everything in it) and the cluster-scoped binding.
fn owner(user: &ColiUser) -> Result<OwnerReference, String> {
    user.controller_owner_ref(&())
        .ok_or_else(|| "the ColiUser has no uid yet".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use coli_crds::{ColiUserSpec, OrgLimits};

    fn user(name: &str, enabled: bool) -> ColiUser {
        let mut u = ColiUser::new(
            name,
            ColiUserSpec {
                login: format!("{name}@example.com"),
                display_name: None,
                enabled,
            },
        );
        u.metadata.uid = Some("0000-1111".into());
        u
    }

    fn alice() -> Desired {
        desired(&user("alice", true), None, None, &Settings::default()).unwrap()
    }

    #[test]
    fn a_user_gets_their_own_namespace() {
        let d = alice();
        assert_eq!(d.namespace.metadata.name.as_deref(), Some("coli-u-alice"));
        assert_eq!(
            daemon_service("coli-u-alice"),
            "coli-daemon.coli-u-alice.svc:7419"
        );
    }

    #[test]
    fn a_name_that_cant_be_a_namespace_is_refused() {
        for bad in ["Alice", "a.b", "x".repeat(60).as_str(), "trailing-"] {
            assert!(
                namespace_for(&user(bad, true)).is_err(),
                "{bad} was accepted"
            );
        }
        assert!(namespace_for(&user(&"x".repeat(56), true)).is_ok());
    }

    #[test]
    fn everything_is_owned_by_the_user_and_lives_in_their_namespace() {
        let d = alice();
        let metas: Vec<&ObjectMeta> = [
            &d.daemon_account.metadata,
            &d.workspace_account.metadata,
            &d.daemon_role.metadata,
            &d.daemon_binding.metadata,
            &d.daemon.metadata,
            &d.service.metadata,
            &d.quota.metadata,
            &d.org_config.metadata,
        ]
        .into_iter()
        .chain(d.network.iter().map(|p| &p.metadata))
        .collect();
        for m in metas {
            assert_eq!(m.namespace.as_deref(), Some("coli-u-alice"), "{:?}", m.name);
            assert_eq!(m.owner_references.as_ref().unwrap()[0].uid, "0000-1111");
        }
        for m in [&d.namespace.metadata, &d.tokenreview_binding.metadata] {
            assert_eq!(m.namespace, None);
            assert_eq!(m.owner_references.as_ref().unwrap()[0].kind, "ColiUser");
        }
    }

    /// operator.md's RBAC table, row for row: anything added here is added on purpose.
    #[test]
    fn the_daemon_reaches_its_own_workspaces_shares_and_pods_and_nothing_else() {
        let d = alice();
        let rules: Vec<(Vec<String>, Vec<String>, Vec<String>)> = d
            .daemon_role
            .rules
            .unwrap()
            .into_iter()
            .map(|r| (r.api_groups.unwrap(), r.resources.unwrap(), r.verbs))
            .collect();
        let s = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            rules,
            vec![
                (
                    s(&["colinear.dev"]),
                    s(&["coliworkspaces", "colishares"]),
                    s(&["get", "list", "watch", "create", "patch", "delete"])
                ),
                (s(&[""]), s(&["pods"]), s(&["get", "list", "watch"])),
            ]
        );
        // a Role, so within its namespace; bound to the daemon alone
        assert_eq!(d.daemon_binding.role_ref.kind, "Role");
        let subjects = d.daemon_binding.subjects.unwrap();
        assert_eq!(subjects.len(), 1);
        assert_eq!(
            (subjects[0].name.as_str(), subjects[0].namespace.as_deref()),
            (DAEMON, Some("coli-u-alice"))
        );
    }

    #[test]
    fn the_cluster_wide_grant_is_tokenreviews_for_this_daemon_only() {
        let b = alice().tokenreview_binding;
        assert_eq!(
            b.metadata.name.as_deref(),
            Some("coli-tokenreview-coli-u-alice")
        );
        assert_eq!(
            (b.role_ref.kind.as_str(), b.role_ref.name.as_str()),
            ("ClusterRole", TOKENREVIEW_ROLE)
        );
        let subjects = b.subjects.unwrap();
        assert_eq!(subjects.len(), 1);
        assert_eq!(
            (subjects[0].name.as_str(), subjects[0].namespace.as_deref()),
            (DAEMON, Some("coli-u-alice"))
        );
    }

    #[test]
    fn a_workspace_has_no_api_token() {
        assert_eq!(
            alice().workspace_account.automount_service_account_token,
            Some(false)
        );
    }

    #[test]
    fn the_daemon_runs_unprivileged() {
        let pod = alice().daemon.spec.unwrap().template.spec.unwrap();
        let psc = pod.security_context.unwrap();
        assert_eq!(psc.run_as_non_root, Some(true));
        assert_eq!(psc.seccomp_profile.unwrap().type_, "RuntimeDefault");
        assert!(pod.host_network.is_none() && pod.host_pid.is_none() && pod.host_ipc.is_none());
        for c in &pod.containers {
            let sc = c.security_context.as_ref().unwrap();
            assert_eq!(sc.allow_privilege_escalation, Some(false));
            assert_eq!(sc.privileged, Some(false));
            assert_eq!(sc.read_only_root_filesystem, Some(true));
            assert_eq!(
                sc.capabilities.as_ref().unwrap().drop.as_deref(),
                Some(&["ALL".to_string()][..])
            );
            assert!(sc.capabilities.as_ref().unwrap().add.is_none());
        }
        // and no volume reaches the node
        assert!(pod.volumes.unwrap().iter().all(|v| v.host_path.is_none()));
    }

    #[test]
    fn a_disabled_user_has_no_daemon_running() {
        let d = desired(&user("alice", false), None, None, &Settings::default()).unwrap();
        assert_eq!(d.daemon.spec.unwrap().replicas, Some(0));
        assert_eq!(alice().daemon.spec.unwrap().replicas, Some(1));
    }

    #[test]
    fn everything_in_the_namespace_is_denied_unless_a_rule_says_otherwise() {
        let d = alice();
        let deny = d
            .network
            .iter()
            .find(|p| p.metadata.name.as_deref() == Some("default-deny"))
            .unwrap();
        let spec = deny.spec.as_ref().unwrap();
        assert_eq!(
            spec.pod_selector,
            Some(LabelSelector::default()),
            "selects every pod"
        );
        assert_eq!(
            spec.policy_types.as_deref(),
            Some(&["Ingress".to_string(), "Egress".to_string()][..])
        );
        assert!(spec.ingress.is_none() && spec.egress.is_none());
    }

    #[test]
    fn a_workspace_reaches_its_daemons_runner_port_and_the_internet_but_nothing_private() {
        let d = alice();
        let ws = d
            .network
            .iter()
            .find(|p| p.metadata.name.as_deref() == Some(WORKSPACE))
            .unwrap();
        let spec = ws.spec.as_ref().unwrap();
        assert_eq!(
            spec.ingress.as_deref(),
            Some(&[][..]),
            "nothing dials a workspace"
        );
        let egress = spec.egress.as_ref().unwrap();
        // the daemon, on the runner port only
        assert_eq!(
            egress[0].ports.as_ref().unwrap()[0].port,
            Some(IntOrString::Int(RUNNER_PORT))
        );
        assert_eq!(egress[0].ports.as_ref().unwrap().len(), 1);
        // the internet, minus every private range and the metadata endpoint
        let blocks: Vec<&IPBlock> = egress
            .iter()
            .flat_map(|r| r.to.iter().flatten())
            .filter_map(|p| p.ip_block.as_ref())
            .collect();
        assert_eq!(blocks.len(), 2);
        for block in blocks {
            let except = block
                .except
                .as_ref()
                .expect("an internet rule always has exceptions");
            if block.cidr == "0.0.0.0/0" {
                for range in [
                    "10.0.0.0/8",
                    "172.16.0.0/12",
                    "192.168.0.0/16",
                    "169.254.0.0/16",
                ] {
                    assert!(except.contains(&range.to_string()), "{range} is reachable");
                }
            }
        }
        // no rule lets it reach another namespace's pods
        for rule in egress {
            for peer in rule.to.iter().flatten() {
                if let Some(ns) = &peer.namespace_selector {
                    assert_eq!(
                        ns.match_labels
                            .as_ref()
                            .unwrap()
                            .get("kubernetes.io/metadata.name")
                            .map(String::as_str),
                        Some("kube-system")
                    );
                    assert_eq!(
                        rule.ports
                            .as_ref()
                            .unwrap()
                            .iter()
                            .map(|p| p.port.clone())
                            .collect::<Vec<_>>(),
                        vec![Some(IntOrString::Int(53)), Some(IntOrString::Int(53))]
                    );
                }
            }
        }
    }

    #[test]
    fn only_the_gateway_and_its_own_workspaces_reach_the_daemon() {
        let d = alice();
        let daemon = d
            .network
            .iter()
            .find(|p| p.metadata.name.as_deref() == Some(DAEMON))
            .unwrap();
        let ingress = daemon.spec.as_ref().unwrap().ingress.as_ref().unwrap();
        assert_eq!(ingress.len(), 2);
        let gateway = &ingress[0].from.as_ref().unwrap()[0];
        assert_eq!(
            gateway
                .namespace_selector
                .as_ref()
                .unwrap()
                .match_labels
                .as_ref()
                .unwrap()["kubernetes.io/metadata.name"],
            "coli-system"
        );
        assert_eq!(
            gateway
                .pod_selector
                .as_ref()
                .unwrap()
                .match_labels
                .as_ref()
                .unwrap()["app.kubernetes.io/name"],
            "coli-gateway"
        );
        assert_eq!(
            ingress[0].ports.as_ref().unwrap()[0].port,
            Some(IntOrString::Int(CLIENT_PORT))
        );
        let runners = &ingress[1].from.as_ref().unwrap()[0];
        assert!(runners.namespace_selector.is_none(), "this namespace only");
        assert_eq!(
            runners
                .pod_selector
                .as_ref()
                .unwrap()
                .match_labels
                .as_ref()
                .unwrap()[ROLE_LABEL],
            "workspace"
        );
        assert_eq!(
            ingress[1].ports.as_ref().unwrap()[0].port,
            Some(IntOrString::Int(RUNNER_PORT))
        );
    }

    #[test]
    fn the_oauth_copy_carries_only_the_apps_identity() {
        let source = BTreeMap::from([
            ("client-id".to_string(), ByteString(b"id".to_vec())),
            ("client-secret".to_string(), ByteString(b"secret".to_vec())),
            (
                "admin-token".to_string(),
                ByteString(b"not for users".to_vec()),
            ),
        ]);
        let d = desired(
            &user("alice", true),
            None,
            Some(&source),
            &Settings::default(),
        )
        .unwrap();
        let keys: Vec<String> = d.linear_oauth.unwrap().data.unwrap().into_keys().collect();
        assert_eq!(keys, vec!["client-id", "client-secret"]);
        assert!(alice().linear_oauth.is_none(), "no source, no copy");
    }

    #[test]
    fn the_quota_follows_the_org() {
        assert_eq!(
            alice().quota.spec.unwrap().hard.unwrap(),
            BTreeMap::from([("pods".into(), Quantity("11".into()))])
        );
        let org = ColiOrgSpec {
            limits: Some(OrgLimits {
                awake_workspaces: Some(3),
                cpu: Some("8".into()),
                storage: Some("200Gi".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let d = desired(&user("alice", true), Some(&org), None, &Settings::default()).unwrap();
        let hard = d.quota.spec.unwrap().hard.unwrap();
        assert_eq!(hard["pods"], Quantity("4".into()));
        assert_eq!(hard["requests.cpu"], Quantity("8".into()));
        assert_eq!(hard["requests.storage"], Quantity("200Gi".into()));
        assert!(!hard.contains_key("requests.memory"));
    }

    #[test]
    fn the_org_config_reaches_the_daemon() {
        let org = ColiOrgSpec {
            idle: Some("30m".into()),
            ..Default::default()
        };
        let d = desired(&user("alice", true), Some(&org), None, &Settings::default()).unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&d.org_config.data.unwrap()["org.json"]).unwrap();
        assert_eq!(json["idle"], "30m");
        assert_eq!(alice().org_config.data.unwrap()["org.json"], "{}");
    }
}
