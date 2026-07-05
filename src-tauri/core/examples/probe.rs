//! Read-only smoke test against the current kubeconfig context:
//! `cargo run -p k8s-visual-core --example probe [namespace]`
//! Exercises the same code paths as the app's connect + main views.

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let namespace = std::env::args().nth(1).unwrap_or_else(|| "default".into());

    let contexts = k8s_visual_core::list_contexts().expect("list_contexts");
    println!(
        "contexts: {:?}",
        contexts.iter().map(|c| &c.name).collect::<Vec<_>>()
    );

    let bridge = match k8s_visual_core::Bridge::connect(None).await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("connect failed: {e}");
            std::process::exit(1);
        }
    };
    println!(
        "connected: {} ({})",
        bridge.info.context, bridge.info.server
    );

    let overview = bridge.overview().await.expect("overview");
    println!(
        "overview: {} nodes, {} namespaces, {} pods ({} failing), {} warning events",
        overview.nodes.len(),
        overview.namespaces.len(),
        overview.pod_count,
        overview.failing_pods,
        overview.warning_events
    );

    let snapshot = bridge.snapshot(&namespace).await.expect("snapshot");
    println!(
        "snapshot {namespace}: {} resources",
        snapshot.resources.len()
    );
    for r in snapshot.resources.iter().take(10) {
        println!("  {} {} - {}", r.kind, r.name, r.status);
    }

    let events = bridge.events(&namespace).await.expect("events");
    println!("events: {}", events.len());

    let metrics = bridge.metrics(&namespace).await.expect("metrics");
    println!(
        "metrics: available={} reason={:?} nodes={} pods={}",
        metrics.available,
        metrics.reason,
        metrics.nodes.len(),
        metrics.pods.len()
    );

    let nodes = bridge.nodes().await.expect("nodes");
    for n in &nodes {
        println!(
            "node {}: ready={} pods={}",
            n.info.name,
            n.info.ready,
            n.pods.len()
        );
    }

    let access = bridge
        .check_access(vec![k8s_visual_core::model::AccessCheck {
            verb: "list".into(),
            resource: "pods".into(),
            group: None,
            namespace: Some(namespace.clone()),
        }])
        .await
        .expect("check_access");
    println!("rbac list pods: allowed={}", access[0].allowed);

    // YAML of the first pod, if any (read-only).
    if let Some(pod) = snapshot.resources.iter().find(|r| r.kind == "Pod") {
        let yaml = bridge
            .yaml("Pod", &namespace, &pod.name)
            .await
            .expect("yaml");
        println!("yaml for {}: {} bytes", pod.name, yaml.len());
        let logs = bridge
            .logs(&k8s_visual_core::model::LogQuery {
                namespace: namespace.clone(),
                pod: pod.name.clone(),
                container: None,
                previous: None,
                tail_lines: Some(5),
                since_seconds: None,
                timestamps: None,
            })
            .await;
        match logs {
            Ok(text) => println!("logs for {}: {} bytes", pod.name, text.len()),
            Err(e) => println!("logs for {}: error {e}", pod.name),
        }
    }

    println!("probe OK");
}
