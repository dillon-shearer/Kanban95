; Anything still running on the installed node.exe (the daemon, an agent's npm or npx, a stray child of a test run on
; the board) locks it, and the copy fails with "Error opening file for writing". Stop every process whose image is this
; install's node.exe before files are written or removed. The path goes through the environment, not the command line,
; so a quote in the user's profile path cannot break the command. CIM, not Get-Process: a 32-bit installer cannot read
; a 64-bit process's path through Get-Process.
!macro KANBAN95_STOP_NODE
  System::Call 'kernel32::SetEnvironmentVariable(t "KANBAN95_NODE", t "$INSTDIR\node.exe")'
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object ExecutablePath -eq $$env:KANBAN95_NODE | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"`
  Pop $0
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro KANBAN95_STOP_NODE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KANBAN95_STOP_NODE
!macroend
