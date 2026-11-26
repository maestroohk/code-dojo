# code-dojo: a plain line-based PowerShell prompt for the dojo's in-page terminal (DOJO_LINE_TERM=1).
# The console host's own line editor (and PSReadLine) redraw the input line with cursor moves after every key,
# which a line-based terminal shows as garbage. This loop reads whole lines instead, keeps reading while the
# input is incomplete (an open brace, a here-string or a pipe at the end, with a ">> " prompt like the real host),
# and runs each complete command in the global scope, so variables and functions stay defined between lines.
# Started by dojo-bashrc as:  pwsh -NoLogo -Command '. /usr/local/lib/dojo/dojo-repl.ps1'
# `exit` (or the terminal closing) leaves a marker so dojo-bashrc knows it was meant; anything else restarts.

function global:__dojo_exit([int] $code) {
    if ($env:DOJO_EXIT_MARK) { $null = New-Item -ItemType File -Force -Path $env:DOJO_EXIT_MARK -ErrorAction SilentlyContinue }
    exit $code
}

while ($true) {
    $__dojo_text = ''
    $__dojo_more = $false
    do {
        $__dojo_p = if ($__dojo_more) { '>> ' } else { try { prompt } catch { 'PS> ' } }
        [Console]::Out.Write($__dojo_p)
        [Console]::Out.Flush()
        $__dojo_line = [Console]::In.ReadLine()
        if ($null -eq $__dojo_line) { __dojo_exit 0 }          # the terminal closed
        $__dojo_text = if ($__dojo_more) { $__dojo_text + "`n" + $__dojo_line } else { $__dojo_line }
        $__dojo_errors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseInput($__dojo_text, [ref] $null, [ref] $__dojo_errors)
        $__dojo_more = @($__dojo_errors | Where-Object IncompleteInput).Count -gt 0
    } while ($__dojo_more)
    if ($__dojo_text.Trim() -eq '') { continue }
    if ($__dojo_text -match '^\s*exit\s*(\d*)\s*;?\s*$') { __dojo_exit ($Matches[1] -as [int]) }
    try {
        . ([scriptblock]::Create($__dojo_text)) | Out-Default
    } catch {
        $_ | Out-Default
    }
}
