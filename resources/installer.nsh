; The portable ZIP keeps data beside its executable. Installed copies use
; Electron's per-user appData directory, which survives uninstall/reinstall.
!macro customInstall
  Delete "$INSTDIR\portable.txt"
!macroend
