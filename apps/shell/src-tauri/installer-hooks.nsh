; ---------------------------------------------------------------------------
; 安装后清理 Windows 图标缓存
;
; ## 为什么需要
;
; 每装一个新版本，exe 换了，但资源管理器**不会立刻重读图标**——
; 任务栏和开始菜单还显示上一版的图标。
;
; 用户实测：v0.104.0 换上了紫色猫耳机器人，但任务栏一直是旧的
; 蓝色 "oc" 方块，直到手动删掉 `IconCache.db` + `iconcache_*.db`
; 并重启 explorer 才变。
;
; 这不是 bug，是 Windows 的缓存策略：它按 (路径 + 时间戳) 命中，
; 而安装器把文件从 temp 移到目标目录时用的是**同一个时间戳**，
; 加上缓存里已经有一条同路径记录，就复用了旧的缩略图。
;
; ## 做法（和微软社区的标准步骤一致）
;
; 1. 结束 explorer（不然文件被占用，删了也立刻写回去）
; 2. 删 `%LOCALAPPDATA%\IconCache.db`（旧格式）
; 3. 删 `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db`（Win10/11）
; 4. 重启 explorer
;
; **只清当前用户的**——清机的图标缓存需要管理员，而且影响别的账户。
; ---------------------------------------------------------------------------

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "正在刷新图标缓存…"

  ${If} ${FileExists} "$LOCALAPPDATA\IconCache.db"
    Delete /REBOOTOK "$LOCALAPPDATA\IconCache.db"
  ${EndIf}

  Delete /REBOOTOK "$LOCALAPPDATA\Microsoft\Windows\Explorer\iconcache_*.db"

  ; 结束 explorer，让它重建缓存。
  ;
  ; 用 taskkill 而不是起 PowerShell：安装器里起 PS 要多几百毫秒，
  ; 有的机器还禁了执行策略。
  nsExec::Exec 'taskkill /f /im explorer.exe'
  Pop $0

  ; 等一下，让 Shell 把内存里的状态落盘（否则删了立刻被写回去）。
  Sleep 800

  ; 再删一次——第一次删的时候文件可能还被占用。
  Delete /REBOOTOK "$LOCALAPPDATA\IconCache.db"
  Delete /REBOOTOK "$LOCALAPPDATA\Microsoft\Windows\Explorer\iconcache_*.db"

  ; 把 explorer 拉起来。
  ;
  ; **必须用 Exec 而不是 ExecWait**：explorer 是常驻进程，
  ; ExecWait 会一直等它退出。
  ;
  ; 注意：Exec 拉起的进程会继承安装器的 stdio 句柄，
  ; 所以用 `Start-Process -Wait` 之类的调用方式等安装器时，
  ; 会一直等不到返回（安装器本身早退了）。这不是卡死——
  ; 用 `/S` 静默装时立即返回即可。
  Exec '"$WINDIR\explorer.exe"'

  DetailPrint "图标缓存已刷新"
!macroend
