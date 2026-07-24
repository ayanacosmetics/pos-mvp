@echo off
setlocal
cd /d "%~dp0"
title Deploy Kasir Nusa ke Vercel
echo.
echo Menyiapkan versi terbaru Kasir Nusa...
echo Jangan tutup jendela ini sampai proses selesai.
echo.
call npx vercel --prod --yes
if errorlevel 1 (
  echo.
  echo Deployment belum berhasil. Foto tampilan pesan ini lalu kirimkan ke Codex.
) else (
  echo.
  echo Deployment berhasil. Buka kembali https://kasir-nusa-pos.vercel.app/
)
echo.
pause
endlocal
