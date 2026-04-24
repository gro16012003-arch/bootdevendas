$git = "C:\Program Files\Git\cmd\git.exe"
& $git init
& $git config user.email "usuario@exemplo.com"
& $git config user.name "Usuario"
& $git remote remove origin 2>$null
& $git remote add origin https://github.com/gro16012003-arch/bootdevendas.git
& $git branch -M main
& $git add .
& $git commit -m "Subindo pasta src e arquivos completos"
& $git push -u origin main -f
