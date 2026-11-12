Add-Type -AssemblyName System.Security
$plain = [Text.Encoding]::UTF8.GetBytes('hello-secret')
$blob = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, 'CurrentUser')
Write-Output ("encrypted bytes: " + $blob.Length)
$b64 = [Convert]::ToBase64String($blob)
Write-Output ("base64 length: " + $b64.Length)

# 再解回来
$back = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')
Write-Output ("decrypted: " + [Text.Encoding]::UTF8.GetString($back))
