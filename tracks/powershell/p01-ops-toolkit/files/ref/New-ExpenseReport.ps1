function New-ExpenseReport {
    <#
    .SYNOPSIS
        Totals an expense export per department and writes an HTML report. Returns the totals.
    .EXAMPLE
        New-ExpenseReport -Path .\expenses-2026-11.csv -OutFile .\reports\expenses-2026-11.html
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)]
        [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
        [string] $Path,

        [Parameter(Mandatory)]
        [string] $OutFile,

        [string] $Title = 'Expenses'
    )
    $totals = Import-Csv -LiteralPath $Path |
        Group-Object Department |
        ForEach-Object {
            [pscustomobject]@{
                Department = $_.Name
                Items      = $_.Count
                Total      = [math]::Round(($_.Group | Measure-Object -Property { [decimal]$_.Amount } -Sum).Sum, 2)
            }
        } |
        Sort-Object Total -Descending
    $style = '<style>body { font-family: Segoe UI, sans-serif } td, th { padding: 4px 12px; text-align: left } th { background: #eee }</style>'
    $html = $totals | ConvertTo-Html -Head "<title>$Title</title>$style" -PreContent "<h1>$Title</h1>"   # -Head replaces -Title
    if ($PSCmdlet.ShouldProcess($OutFile, 'Write expense report')) {
        $html | Set-Content -LiteralPath $OutFile -Encoding utf8
    }
    $totals
}
