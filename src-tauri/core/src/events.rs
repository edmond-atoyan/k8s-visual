//! Kubernetes events, condensed for the timeline view.

use k8s_openapi::api::core::v1::Event;
use kube::api::{Api, ListParams};
use kube::Client;

use crate::model::EventInfo;
use crate::Result;

pub async fn list(client: &Client, namespace: &str) -> Result<Vec<EventInfo>> {
    let api = Api::<Event>::namespaced(client.clone(), namespace);
    let events = api.list(&ListParams::default().limit(500)).await?;
    let mut out: Vec<EventInfo> = events.items.iter().map(map_event).collect();
    // Newest last-seen first.
    out.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    Ok(out)
}

fn map_event(ev: &Event) -> EventInfo {
    let last_seen = ev
        .last_timestamp
        .as_ref()
        .map(|t| t.0.to_string())
        .or_else(|| ev.event_time.as_ref().map(|t| t.0.to_string()))
        .or_else(|| {
            ev.series
                .as_ref()
                .and_then(|s| s.last_observed_time.as_ref())
                .map(|t| t.0.to_string())
        });
    EventInfo {
        r#type: ev.type_.clone().unwrap_or_else(|| "Normal".into()),
        reason: ev.reason.clone().unwrap_or_default(),
        message: ev.message.clone().unwrap_or_default(),
        involved_kind: ev.involved_object.kind.clone().unwrap_or_default(),
        involved_name: ev.involved_object.name.clone().unwrap_or_default(),
        count: ev
            .count
            .or_else(|| ev.series.as_ref().and_then(|s| s.count))
            .unwrap_or(1),
        first_seen: ev.first_timestamp.as_ref().map(|t| t.0.to_string()),
        last_seen,
    }
}
