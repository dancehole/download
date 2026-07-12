@echo off
chcp 65001 >nul
setlocal

echo ============================================
echo   活动照片流系统 - 启动服务
echo ============================================

cd /d "%~dp0"

if not exist "venv\Scripts\python.exe" (
    echo [错误] 未找到虚拟环境 venv，请先运行 install.bat
    pause
    exit /b 1
)

if not exist ".env" (
    echo [警告] 未找到 .env 配置文件，将使用默认配置
)

echo.
echo [1/3] 检查数据库连接...
venv\Scripts\python.exe -c "import aiomysql, asyncio; async def t(): c=await aiomysql.connect(host='127.0.0.1',port=3306,user='root',password='root'); await c.ensure_closed(); print('  MySQL 连接正常'); asyncio.run(t())" 2>nul
if errorlevel 1 (
    echo [错误] MySQL 连接失败，请确认 MySQL 服务已启动且 .env 中账号密码正确
    pause
    exit /b 1
)

echo [2/3] 确认存储目录...
if not exist "storage" mkdir storage
echo   存储目录: %cd%\storage

echo [3/3] 启动服务...
echo   监听地址: http://127.0.0.1:8765
echo   后台管理: http://127.0.0.1:8765/admin
echo   按 Ctrl+C 停止服务
echo.
echo ============================================

venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8765 --workers 2

endlocal
