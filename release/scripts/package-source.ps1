$ErrorActionPreference = "Stop"
$Script = Join-Path $PSScriptRoot "package_sources.py"
$Arguments = $args

if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 -B $Script @Arguments
} elseif (Get-Command python3 -ErrorAction SilentlyContinue) {
    & python3 -B $Script @Arguments
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    & python -B $Script @Arguments
} else {
    throw "Python 3.9 or newer is required."
}

exit $LASTEXITCODE
