use std::process::Command;

#[test]
fn shell_refuses_to_start_inside_an_agent_session() {
    let scratch = std::env::temp_dir().join(format!("kanban95-agent-refuses-{}", std::process::id()));
    let out = Command::new(env!("CARGO_BIN_EXE_kanban95-shell"))
        .env("KANBAN95_AGENT", "1")
        .env("KANBAN95_HOME", &scratch)
        .env("KANBAN95_SHELL_LOG", scratch.join("shell.log"))
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "Kanban95 is already running; agents verify headlessly, see docs/AGENTS.md\n"
    );
    assert!(out.stdout.is_empty());
    assert!(!scratch.exists());
}
