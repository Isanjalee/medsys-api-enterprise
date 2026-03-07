$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repo

$env:NODE_ENV = 'development'
$env:HOST = '0.0.0.0'
$env:PORT = '4000'
$env:DATABASE_URL = 'postgres://medsys:medsys@localhost:5432/medsys'
$env:DATABASE_READ_URL = 'postgres://medsys:medsys@localhost:5432/medsys'
$env:REDIS_URL = 'redis://localhost:6379'
$env:AUDIT_TRANSPORT = 'auto'
$env:AUDIT_QUEUE_KEY = 'medsys:audit:events'
$env:AUDIT_WORKER_BLOCK_SECONDS = '5'
$env:ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111'
$env:JWT_ACCESS_PRIVATE_KEY = Get-Content (Join-Path $repo 'access.priv.pem') -Raw
$env:JWT_ACCESS_PUBLIC_KEY = Get-Content (Join-Path $repo 'access.pub.pem') -Raw
$env:JWT_REFRESH_PRIVATE_KEY = Get-Content (Join-Path $repo 'refresh.priv.pem') -Raw
$env:JWT_REFRESH_PUBLIC_KEY = Get-Content (Join-Path $repo 'refresh.pub.pem') -Raw
$env:ACCESS_TOKEN_TTL_SECONDS = '900'
$env:REFRESH_TOKEN_TTL_SECONDS = '604800'
$env:REQUEST_ID_HEADER = 'x-request-id'

node apps/api/dist/apps/api/src/index.js
