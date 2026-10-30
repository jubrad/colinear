//! colinear's custom resources (design/multi-user/operator.md, "Resources").
//!
//! Group `colinear.dev`, version `v1alpha1`. The group is a placeholder until
//! there is a domain to put it under.
//!
//! The rule these types keep: **nothing a user's daemon can write names
//! anything security-relevant.** A `ColiWorkspace` says which repo and which
//! size class, both looked up in the org's lists; it has no field for an
//! image, a command, a volume, a node or a privilege, so a daemon cannot ask
//! for one.

use std::collections::BTreeMap;

use kube::CustomResource;
use kube::core::CustomResourceExt;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const GROUP: &str = "colinear.dev";
pub const VERSION: &str = "v1alpha1";

/// The org's config: who may sign in, which repos exist and what builds them,
/// and the defaults and locks every user's config sits under
/// (design/multi-user/config.md). One per install.
#[derive(CustomResource, Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[kube(
    group = "colinear.dev",
    version = "v1alpha1",
    kind = "ColiOrg",
    plural = "coliorgs"
)]
#[serde(rename_all = "camelCase")]
pub struct ColiOrgSpec {
    pub users: OrgUsers,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracker: Option<OrgTracker>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github: Option<OrgGitHub>,
    #[serde(default)]
    pub repos: Vec<OrgRepo>,
    /// named sizes a workspace can ask for
    #[serde(default)]
    pub workspace_classes: BTreeMap<String, WorkspaceClass>,
    /// how long an unused workspace pod lives before its daemon puts it to sleep, e.g. "30m"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<OrgModels>,
    /// anything a user's config can hold, as the org's default
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "preserve_unknown")]
    pub config: Option<serde_json::Value>,
    /// config keys a user may not override
    #[serde(default)]
    pub locked: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<OrgLimits>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrgUsers {
    /// tailnet logins, or `*@domain`
    pub allow: Vec<String>,
    /// who sees every user's costs
    #[serde(default)]
    pub admins: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrgTracker {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_client_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrgGitHub {
    pub app_client_id: String,
    pub app_slug: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrgRepo {
    pub name: String,
    pub url: String,
    #[serde(default = "main_branch")]
    pub default_branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// what a workspace for this repo runs: the agent's whole environment
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// the size class its workspaces get unless they ask for another
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    #[serde(default)]
    pub checks: Vec<RepoCheck>,
}

fn main_branch() -> String {
    "main".into()
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
pub struct RepoCheck {
    pub name: String,
    pub cmd: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
pub struct WorkspaceClass {
    pub cpu: String,
    pub memory: String,
    pub disk: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
pub struct OrgModels {
    #[serde(default)]
    pub allow: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrgLimits {
    /// the most sessions one user's daemon runs at once. i32, not u32: Kubernetes
    /// validates int32 and warns about any format it doesn't know
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub concurrency: Option<i32>,
    /// the most workspace pods one user has awake at once
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub awake_workspaces: Option<i32>,
    /// one user's total CPU and memory requests, daemon included, e.g. "16" and "64Gi"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<String>,
    /// one user's total volume size, every sleeping workspace included, e.g. "500Gi"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage: Option<String>,
}

/// One person. The gateway creates it at first sign-in for anyone the org
/// allows; the operator turns it into a namespace with a daemon in it.
#[derive(CustomResource, Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[kube(
    group = "colinear.dev",
    version = "v1alpha1",
    kind = "ColiUser",
    plural = "coliusers",
    status = "ColiUserStatus",
    printcolumn = r#"{"name":"Login","type":"string","jsonPath":".spec.login"}"#,
    printcolumn = r#"{"name":"Namespace","type":"string","jsonPath":".status.namespace"}"#,
    printcolumn = r#"{"name":"Ready","type":"boolean","jsonPath":".status.daemon.ready"}"#
)]
#[serde(rename_all = "camelCase")]
pub struct ColiUserSpec {
    /// the tailnet identity
    pub login: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// false: the daemon is stopped and every workspace sleeps
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColiUserStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daemon: Option<DaemonStatus>,
    /// why the operator can't serve this user, when it can't
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq)]
pub struct DaemonStatus {
    pub ready: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
}

/// One worktree: a task's, a review's, a plan's, or a user's scratch space.
/// Written by that user's daemon; the operator decides everything about the
/// pod that serves it.
#[derive(CustomResource, Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[kube(
    group = "colinear.dev",
    version = "v1alpha1",
    kind = "ColiWorkspace",
    plural = "coliworkspaces",
    namespaced,
    status = "ColiWorkspaceStatus",
    printcolumn = r#"{"name":"Kind","type":"string","jsonPath":".spec.kind"}"#,
    printcolumn = r#"{"name":"Repo","type":"string","jsonPath":".spec.repo"}"#,
    printcolumn = r#"{"name":"Phase","type":"string","jsonPath":".status.phase"}"#
)]
#[serde(rename_all = "camelCase")]
pub struct ColiWorkspaceSpec {
    pub kind: WorkspaceKind,
    /// a name from ColiOrg.repos; absent for scratch
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// a name from ColiOrg.workspaceClasses; absent takes the repo's
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    /// the daemon wants a pod now
    #[serde(default)]
    pub awake: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceKind {
    #[default]
    Task,
    Review,
    Plan,
    Scratch,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq)]
pub struct ColiWorkspaceStatus {
    pub phase: WorkspacePhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pod: Option<PodRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
pub enum WorkspacePhase {
    #[default]
    Pending,
    Ready,
    Sleeping,
    Failed,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq)]
pub struct PodRef {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
}

/// An index entry for something shared (design/multi-user/sharing.md). The
/// owner's daemon writes it and stays the authority on access: the gateway
/// lists these, but every read of the content is checked by the owner's
/// daemon, so a stale or tampered entry can show a title and nothing more.
#[derive(CustomResource, Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[kube(
    group = "colinear.dev",
    version = "v1alpha1",
    kind = "ColiShare",
    plural = "colishares",
    namespaced
)]
#[serde(rename_all = "camelCase")]
pub struct ColiShareSpec {
    pub owner: String,
    pub item: SharedItem,
    pub audience: Audience,
    #[serde(default)]
    pub users: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
pub struct SharedItem {
    pub kind: SharedKind,
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SharedKind {
    #[default]
    Task,
    Review,
    Plan,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Audience {
    #[default]
    Users,
    Everyone,
}

/// A free-form object: the org's default user config takes any key a user's can.
fn preserve_unknown(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({
        "type": "object",
        "x-kubernetes-preserve-unknown-fields": true
    })
}

/// Every CRD, as the YAML the chart installs: one document each, in a fixed order.
pub fn crds_yaml() -> String {
    [
        ColiOrg::crd(),
        ColiUser::crd(),
        ColiWorkspace::crd(),
        ColiShare::crd(),
    ]
    .iter()
    .map(|crd| serde_yaml_ng::to_string(crd).expect("a CRD always serializes"))
    .collect::<Vec<_>>()
    .join("---\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec_properties(
        crd: &k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition,
    ) -> Vec<String> {
        let schema = crd.spec.versions[0]
            .schema
            .as_ref()
            .unwrap()
            .open_api_v3_schema
            .as_ref()
            .unwrap();
        let spec = schema.properties.as_ref().unwrap().get("spec").unwrap();
        spec.properties.as_ref().unwrap().keys().cloned().collect()
    }

    /// The property this whole design leans on: a daemon writes ColiWorkspace,
    /// and nothing it can write there picks an image, a command, a volume, a
    /// node or a privilege. A field added here gets added to this list on purpose.
    #[test]
    fn a_workspace_names_nothing_security_relevant() {
        let fields = spec_properties(&ColiWorkspace::crd());
        assert_eq!(fields, vec!["awake", "class", "kind", "repo"]);
    }

    #[test]
    fn workspace_kinds_are_a_closed_list() {
        let crd = ColiWorkspace::crd();
        let yaml = serde_yaml_ng::to_string(&crd).unwrap();
        for kind in ["task", "review", "plan", "scratch"] {
            assert!(yaml.contains(&format!("- {kind}")), "missing kind {kind}");
        }
    }

    #[test]
    fn scopes_are_what_the_design_says() {
        assert_eq!(ColiOrg::crd().spec.scope, "Cluster");
        assert_eq!(ColiUser::crd().spec.scope, "Cluster");
        assert_eq!(ColiWorkspace::crd().spec.scope, "Namespaced");
        assert_eq!(ColiShare::crd().spec.scope, "Namespaced");
    }

    #[test]
    fn the_org_config_takes_any_user_key() {
        let yaml = serde_yaml_ng::to_string(&ColiOrg::crd()).unwrap();
        assert!(yaml.contains("x-kubernetes-preserve-unknown-fields: true"));
    }

    /// the API server warns on formats it doesn't know (uint32 was one)
    #[test]
    fn every_format_is_one_kubernetes_knows() {
        let yaml = crds_yaml();
        for line in yaml
            .lines()
            .filter(|l| l.trim_start().starts_with("format:"))
        {
            let format = line.trim_start().trim_start_matches("format:").trim();
            assert!(
                ["int32", "int64", "date-time", "byte", "date"].contains(&format),
                "unknown format {format}"
            );
        }
    }

    #[test]
    fn a_user_is_enabled_unless_said_otherwise() {
        let user: ColiUserSpec = serde_json::from_str(r#"{"login":"alice@example.com"}"#).unwrap();
        assert!(user.enabled);
    }

    #[test]
    fn every_crd_is_in_the_chart_yaml() {
        let yaml = crds_yaml();
        for name in [
            "coliorgs.colinear.dev",
            "coliusers.colinear.dev",
            "coliworkspaces.colinear.dev",
            "colishares.colinear.dev",
        ] {
            assert!(yaml.contains(&format!("name: {name}")), "missing {name}");
        }
    }
}
