# code-dojo: the all-users profile ($PSHOME/profile.ps1) of the pwsh image for terminal steps.
# In the dojo's line-based in-page terminal (DOJO_LINE_TERM=1, where dojo-repl.ps1 reads the lines) a few things
# that need a full screen are replaced:
#   - progress bars draw with cursor moves: they are hidden;
#   - nano / vim / vi / code / notepad open the file in the page's editor (the same OSC marker as dojo-linerc);
#   - the prompt is short: PS ~/folder>
if ($env:DOJO_LINE_TERM -eq '1') {
    $global:ProgressPreference = 'SilentlyContinue'

    function global:prompt {
        $here = $executionContext.SessionState.Path.CurrentLocation.ProviderPath
        if ($here -eq $HOME) { $here = '~' }
        elseif ($here.StartsWith("$HOME/")) { $here = '~' + $here.Substring($HOME.Length) }
        "`e[1;36mPS`e[0m `e[1;34m$here`e[0m> "
    }

    function global:Open-DojoEditor {
        param([string] $Program, [string[]] $Arguments)
        $file = $Arguments | Where-Object { $_ -and $_ -notmatch '^[-+]' } | Select-Object -First 1
        if (-not $file) {
            Write-Host "dojo: name the file to edit: $Program ./path/to/file (it opens in an editor on the page)."
            return
        }
        $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($file)
        if (Test-Path -LiteralPath $full -PathType Container) { Write-Host "dojo: $full is a folder, not a file."; return }
        [Console]::Write("`e]dojo;edit;$full`a")
        Write-Host "dojo: $Program opened $full in the editor on the page (this terminal is line based). Save there (Ctrl+S), then carry on here."
    }
    foreach ($editor in 'nano', 'vim', 'vi', 'code', 'notepad') {
        Set-Item -Path "function:global:$editor" -Value ([scriptblock]::Create("Open-DojoEditor -Program '$editor' -Arguments `$args"))
    }
}
