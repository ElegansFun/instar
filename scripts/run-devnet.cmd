@echo off
rem Run the world against devnet with the keys under .keys\mainnet (never committed).
rem   scripts\run-devnet.cmd
setlocal
cd /d %~dp0..
for /f "usebackq tokens=1,* delims==" %%a in (".keys\mainnet\rpc.env") do if "%%a"=="INSTAR_RPC_DEVNET" set "INSTAR_RPC=%%b"
for /f "usebackq tokens=1,* delims==" %%a in (".keys\mainnet\google.env") do if "%%a"=="GOOGLE_CLIENT_ID" set "GOOGLE_CLIENT_ID=%%b"
for /f "usebackq" %%k in (".keys\mainnet\devnet-master.key") do set "INSTAR_MASTER_KEY=%%k"
set INSTAR_CLUSTER=devnet
set INSTAR_OPERATOR_KEYPAIR=.keys\mainnet\operator.json
set INSTAR_FEE_KEYPAIR=.keys\mainnet\fee.json
set DATA_DIR=data\world-devnet
set PORT=%INSTAR_PORT%
if "%PORT%"=="" set PORT=8791
set PUBLIC_URL=https://devnet-rehearsal.instar.invalid
npx.cmd tsx services/world/index.mts
