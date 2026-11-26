function Get-FolderUsage {
    <#
    .SYNOPSIS
        Size and file count of each folder directly under -Path, biggest first.
    .EXAMPLE
        Get-FolderUsage -Path \\fs01\share | ConvertTo-Html -Title 'Share usage' | Set-Content usage.html
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
        [string] $Path
    )
    Get-ChildItem -LiteralPath $Path -Directory | ForEach-Object {
        $files = @(Get-ChildItem -LiteralPath $_.FullName -Recurse -File)
        $bytes = ($files | Measure-Object -Property Length -Sum).Sum
        [pscustomobject]@{
            Folder = $_.Name
            Files  = $files.Count
            SizeMB = [math]::Round([double]$bytes / 1MB, 1)
        }
    } | Sort-Object SizeMB -Descending
}
