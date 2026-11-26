function Rename-ScanByDate {
    <#
    .SYNOPSIS
        Renames scanner PDFs to yyyy-MM-dd_HHmm_<name>.pdf by when they were scanned, so they sort by date.
    .EXAMPLE
        Rename-ScanByDate -Path \\fs01\scans -WhatIf
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)]
        [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
        [string] $Path
    )
    Get-ChildItem -LiteralPath $Path -File -Filter *.pdf |
        Where-Object Name -notmatch '^\d{4}-\d{2}-\d{2}_\d{4}_' |
        ForEach-Object {
            $newName = '{0:yyyy-MM-dd_HHmm}_{1}' -f $_.LastWriteTime, $_.Name
            if (Test-Path -LiteralPath (Join-Path $_.DirectoryName $newName)) {
                Write-Warning "$newName already exists: skipping $($_.Name)"
                return
            }
            if ($PSCmdlet.ShouldProcess($_.FullName, "Rename to $newName")) {
                Rename-Item -LiteralPath $_.FullName -NewName $newName -PassThru
            }
        }
}
