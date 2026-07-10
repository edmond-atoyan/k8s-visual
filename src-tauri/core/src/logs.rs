//! Pod log access: one-shot fetch and follow streams.
//! Logs never leave the machine - they go straight to the UI.

use futures::{AsyncBufReadExt, Stream, StreamExt, TryStreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, LogParams};
use kube::Client;

use crate::model::LogQuery;
use crate::Result;

fn params(query: &LogQuery, follow: bool) -> LogParams {
    LogParams {
        container: query.container.clone(),
        follow,
        previous: query.previous.unwrap_or(false),
        since_seconds: query.since_seconds,
        tail_lines: Some(query.tail_lines.unwrap_or(500)),
        timestamps: query.timestamps.unwrap_or(false),
        ..Default::default()
    }
}

/// Equivalent of `kubectl logs [--previous] [--tail] [-c container]`.
pub async fn fetch(client: &Client, query: &LogQuery) -> Result<String> {
    let api = Api::<Pod>::namespaced(client.clone(), &query.namespace);
    Ok(api.logs(&query.pod, &params(query, false)).await?)
}

/// Equivalent of `kubectl logs -f`; yields one log line per item.
pub async fn stream(
    client: &Client,
    query: &LogQuery,
) -> Result<impl Stream<Item = String> + Send + Unpin> {
    let api = Api::<Pod>::namespaced(client.clone(), &query.namespace);
    let reader = api.log_stream(&query.pod, &params(query, true)).await?;
    Ok(reader
        .lines()
        .into_stream()
        .filter_map(|line| async move { line.ok() })
        .boxed())
}
