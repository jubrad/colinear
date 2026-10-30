//! The colinear operator (design/multi-user/operator.md). It is the only
//! component that creates pods: daemons ask for workspaces by writing a
//! ColiWorkspace, and this decides everything about the pod that serves it.
//!
//! This is the skeleton: it connects, confirms the CRDs are installed, and
//! waits. The reconcilers arrive in their own steps (work order 3.2, 3.4).

use anyhow::Context;
use coli_crds::{ColiUser, ColiWorkspace};
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
    // listing proves both that we can reach the API and that the CRDs are there
    let users: Api<ColiUser> = Api::all(client.clone());
    let workspaces: Api<ColiWorkspace> = Api::all(client);
    let u = users
        .list(&Default::default())
        .await
        .context("ColiUser is not installed — apply the chart's CRDs")?;
    let w = workspaces
        .list(&Default::default())
        .await
        .context("ColiWorkspace is not installed")?;
    tracing::info!(
        users = u.items.len(),
        workspaces = w.items.len(),
        "colinear operator up; no reconcilers yet"
    );
    tokio::signal::ctrl_c().await?;
    Ok(())
}
