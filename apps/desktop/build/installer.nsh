; Custom NSIS hooks, included automatically by electron-builder
; (build/installer.nsh). electron-builder's `protocols` setting only writes the
; macOS Info.plist and the Linux .desktop file, so the freilauf:// URL scheme
; is registered on Windows here. SHCTX is HKCU for the per-user installer.
;
; The app does not handle freilauf:// links yet; registering the scheme now
; means the installer will not need to change once it does.

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\freilauf" "" "URL:Freilauf"
  WriteRegStr SHCTX "Software\Classes\freilauf" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\freilauf\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\freilauf\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ; Keep the registration when the uninstaller runs as part of an update.
  ${ifNot} ${isUpdated}
    DeleteRegKey SHCTX "Software\Classes\freilauf"
  ${endIf}
!macroend
