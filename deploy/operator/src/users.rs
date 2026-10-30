//! The `ColiUser` controller: applies [`crate::user::desired`] and reports
//! the daemon's state back on the user.
//!
//! No finalizer: everything a user has is owned by their `ColiUser`, so
//! Kubernetes' garbage collector deletes the lot when it goes.

use std::collections::BTreeMap;
use std::fmt::Debug;

use coli_crds::{ColiOrg, ColiOrgSpec, ColiUser, ColiUserStatus, ColiWorkspace, DaemonStatus};
use k8s_controller::{Context, TraceMetadata};
use k8s_openapi::ByteString;
use k8s_openapi::api::apps::v1::StatefulSet;
use k8s_openapi::api::core::v1::Secret;
use k8s_openapi::{ClusterResourceScope, NamespaceResourceScope};
use kube::api::{ListParams, Patch, PatchParams};
use kube::runtime::controller::Action;
use kube::{Api, Client, Resource, ResourceExt};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::user::{self, DAEMON, Desired, LINEAR_OAUTH, Settings};

const MANAGER: &str = "coli-operator";

#[derive(Clone)]
pub struct Users {
    pub settings: Settings,
}

#[async_trait::async_trait]
impl Context for Users {
    type Resource = ColiUser;
    type Error = kube::Error;

    async fn apply(
        &self,
        client: Client,
        user: &ColiUser,
        _metadata: &mut TraceMetadata,
    ) -> Result<Option<Action>, kube::Error> {
        let org = org(&client).await?;
        let oauth = linear_oauth(&client, &self.settings.system_namespace).await?;
        let desired = match user::desired(user, org.as_ref(), oauth.as_ref(), &self.settings) {
            Ok(d) => d,
            // nothing to retry until someone changes the user
            Err(message) => {
                set_status(
                    &client,
                    user,
                    ColiUserStatus {
                        message: Some(message),
                        ..Default::default()
                    },
                )
                .await?;
                return Ok(Some(Action::await_change()));
            }
        };
        let ns = desired.namespace.name_any();
        apply_all(&client, &desired).await?;
        if !user.spec.enabled {
            sleep_workspaces(&client, &ns).await?;
        }

        let daemon: Api<StatefulSet> = Api::namespaced(client.clone(), &ns);
        let ready = user.spec.enabled
            && daemon
                .get_opt(DAEMON)
                .await?
                .and_then(|s| s.status)
                .and_then(|s| s.ready_replicas)
                .is_some_and(|n| n > 0);
        set_status(
            &client,
            user,
            ColiUserStatus {
                daemon: Some(DaemonStatus {
                    ready,
                    service: Some(user::daemon_service(&ns)),
                }),
                namespace: Some(ns),
                message: None,
            },
        )
        .await?;
        Ok(None)
    }
}

/// The install's one org config. Absent is allowed: a cluster can be set up
/// before it's decided, and users get the defaults.
async fn org(client: &Client) -> Result<Option<ColiOrgSpec>, kube::Error> {
    let orgs: Api<ColiOrg> = Api::all(client.clone());
    Ok(orgs
        .list(&ListParams::default())
        .await?
        .items
        .into_iter()
        .next()
        .map(|o| o.spec))
}

async fn linear_oauth(
    client: &Client,
    system: &str,
) -> Result<Option<BTreeMap<String, ByteString>>, kube::Error> {
    let secrets: Api<Secret> = Api::namespaced(client.clone(), system);
    Ok(secrets.get_opt(LINEAR_OAUTH).await?.and_then(|s| s.data))
}

/// Server-side apply, so the operator owns exactly the fields it sets and a
/// field someone else changed by hand comes back on the next pass.
async fn apply_all(client: &Client, d: &Desired) -> Result<(), kube::Error> {
    // the namespace first: everything else goes in it
    apply_cluster(client, &d.namespace).await?;
    apply_cluster(client, &d.tokenreview_binding).await?;
    apply_namespaced(client, &d.daemon_account).await?;
    apply_namespaced(client, &d.workspace_account).await?;
    apply_namespaced(client, &d.daemon_role).await?;
    apply_namespaced(client, &d.daemon_binding).await?;
    // the network policies before any pod: a pod never runs unfenced
    for policy in &d.network {
        apply_namespaced(client, policy).await?;
    }
    apply_namespaced(client, &d.quota).await?;
    apply_namespaced(client, &d.org_config).await?;
    if let Some(secret) = &d.linear_oauth {
        apply_namespaced(client, secret).await?;
    }
    apply_namespaced(client, &d.service).await?;
    apply_namespaced(client, &d.daemon).await?;
    Ok(())
}

async fn apply_cluster<K>(client: &Client, obj: &K) -> Result<(), kube::Error>
where
    K: Resource<DynamicType = (), Scope = ClusterResourceScope>
        + Serialize
        + DeserializeOwned
        + Clone
        + Debug,
{
    let api: Api<K> = Api::all(client.clone());
    api.patch(
        &obj.name_any(),
        &PatchParams::apply(MANAGER).force(),
        &Patch::Apply(obj),
    )
    .await?;
    Ok(())
}

async fn apply_namespaced<K>(client: &Client, obj: &K) -> Result<(), kube::Error>
where
    K: Resource<DynamicType = (), Scope = NamespaceResourceScope>
        + Serialize
        + DeserializeOwned
        + Clone
        + Debug,
{
    let ns = obj
        .namespace()
        .expect("every namespaced object here names its namespace");
    let api: Api<K> = Api::namespaced(client.clone(), &ns);
    api.patch(
        &obj.name_any(),
        &PatchParams::apply(MANAGER).force(),
        &Patch::Apply(obj),
    )
    .await?;
    Ok(())
}

/// A disabled user's workspaces all sleep: their pods go, their volumes stay.
async fn sleep_workspaces(client: &Client, ns: &str) -> Result<(), kube::Error> {
    let workspaces: Api<ColiWorkspace> = Api::namespaced(client.clone(), ns);
    for ws in workspaces.list(&ListParams::default()).await? {
        if ws.spec.awake {
            let patch = serde_json::json!({ "spec": { "awake": false } });
            workspaces
                .patch(
                    &ws.name_any(),
                    &PatchParams::default(),
                    &Patch::Merge(&patch),
                )
                .await?;
        }
    }
    Ok(())
}

async fn set_status(
    client: &Client,
    user: &ColiUser,
    status: ColiUserStatus,
) -> Result<(), kube::Error> {
    if user.status.as_ref() == Some(&status) {
        return Ok(());
    }
    let users: Api<ColiUser> = Api::all(client.clone());
    let patch = serde_json::json!({ "status": status });
    users
        .patch_status(
            &user.name_any(),
            &PatchParams::default(),
            &Patch::Merge(&patch),
        )
        .await?;
    Ok(())
}
