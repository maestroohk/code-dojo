function New-ExpenseReport {
    <#
    .SYNOPSIS
        Totals an expense export per department. (The HTML report is still to do.)
    #>
    [CmdletBinding()]
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
    $totals
}
