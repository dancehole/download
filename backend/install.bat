@echo off
chcp 65001 >nul
setlocal

echo ============================================
echo   活动照片流系统 - 安装依赖
echo ============================================
echo.

cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Python，请先安装 Python 3.10+
    pause
    exit /b 1
)

if not exist "venv\Scripts\python.exe" (
    echo [1/3] 创建虚拟环境 venv ...
    python -m venv venv
    if errorlevel 1 (
        echo [错误] 虚拟环境创建失败
        pause
        exit /b 1
    )
    echo   完成
) else (
    echo [1/3] 虚拟环境已存在，跳过
)

echo.
echo [2/3] 安装依赖包 ...
venv\Scripts\pip install --upgrade pip
venv\Scripts\pip install -r requirements.txt
if errorlevel 1 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
)
echo   完成

if not exist ".env" (
    echo.
    echo [3/3] 生成默认 .env 配置文件 ...
    copy .env.example .env >nul
    echo   已生成 .env，请根据实际情况修改数据库密码等配置
) else (
    echo.
    echo [3/3] .env 已存在，跳过
)

echo.
echo ============================================
echo   安装完成！
echo   修改 .env 配置后双击 start.bat 启动服务
echo ============================================
pause
endlocal
