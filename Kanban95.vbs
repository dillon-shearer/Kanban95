' Kanban95 launcher without a console window. Double-click it, or drop a project folder onto it.
' Runs Kanban95.cmd hidden; if that fails (no Node 24, install or build error) a dialog shows the end of its output.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
logPath = sh.ExpandEnvironmentStrings("%TEMP%") & "\kanban95-start.log"
args = ""
For Each a In WScript.Arguments
  args = args & " """ & a & """"
Next
sh.Environment("Process")("KANBAN95_HIDDEN") = "1"
code = sh.Run("cmd /c """"" & dir & "\Kanban95.cmd""" & args & " > """ & logPath & """ 2>&1""", 0, True)
If code <> 0 Then
  out = ""
  If fso.FileExists(logPath) Then
    Set f = fso.OpenTextFile(logPath)
    If Not f.AtEndOfStream Then out = f.ReadAll
    f.Close
  End If
  If Len(out) > 1500 Then out = "..." & Right(out, 1500)
  MsgBox out & vbCrLf & "Full output: " & logPath, vbExclamation, "Kanban95 did not start"
End If
