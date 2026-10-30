//! The colinear operator (design/multi-user/operator.md). It is the only
//! component that creates pods: daemons ask for workspaces by writing a
//! ColiWorkspace, and this decides everything about the pod that serves it.
//!
//! Reconcilers so far: `ColiUser` (work order 3.2). `ColiWorkspace` is 3.4.

mod user;
mod users;

use anyhow::Context as _;
use coli_crds::{ColiOrg, ColiUser};
use futures::{StreamExt, stream};
use k8s_openapi::api::apps::v1::StatefulSet;
use k8s_openapi::api::core::v1::Secret;
use kube::runtime::{WatchStreamExt, watcher};
use kube::{Api, Client};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let client = Client::try_default()
        .await
        .context("no Kubernetes to talk to")?;
    // a missing CRD is a setup mistake worth saying plainly, not a watch that retries forever
    let users: Api<ColiUser> = Api::all(client.clone());
    users
        .list(&Default::default())
        .await
        .context("ColiUser is not installed — apply the chart's CRDs")?;

    let settings = settings();
    tracing::info!(?settings, "colinear operator up");

    // every user's objects depend on the org (its config, its limits) and on
    // the org's Linear OAuth Secret, so a change to either revisits them all
    let orgs = watcher(
        Api::<ColiOrg>::all(client.clone()),
        watcher::Config::default(),
    )
    .touched_objects()
    .map(|_| ());
    let oauth = watcher(
        Api::<Secret>::namespaced(client.clone(), &settings.system_namespace),
        watcher::Config::default().fields(&format!("metadata.name={}", user::LINEAR_OAUTH)),
    )
    .touched_objects()
    .map(|_| ());

    let controller = k8s_controller::Controller::cluster(
        client.clone(),
        users::Users { settings },
        watcher::Config::default(),
    )
    .with_name("coli-users")
    .with_controller(|c| {
        c.owns(
            Api::<StatefulSet>::all(client.clone()),
            watcher::Config::default().labels("app.kubernetes.io/managed-by=coli-operator"),
        )
        .reconcile_all_on(stream::select(orgs, oauth))
    });

    tokio::select! {
        () = controller.run() => anyhow::bail!("the user controller stopped"),
        r = tokio::signal::ctrl_c() => r.context("waiting for a signal")?,
    }
    Ok(())
}

/// What this install runs daemons with: the chart sets these.
fn settings() -> user::Settings {
    let mut s = user::Settings::default();
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    if let Some(v) = var("POD_NAMESPACE") {
        s.system_namespace = v;
    }
    if let Some(v) = var("COLI_DAEMON_IMAGE") {
        s.daemon_image = v;
    }
    if let Some(v) = var("COLI_DAEMON_CPU") {
        s.daemon_cpu = v;
    }
    if let Some(v) = var("COLI_DAEMON_MEMORY") {
        s.daemon_memory = v;
    }
    if let Some(v) = var("COLI_DAEMON_DISK") {
        s.daemon_disk = v;
    }
    s
}
