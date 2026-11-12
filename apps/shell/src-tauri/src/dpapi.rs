//! 密钥加密（Windows DPAPI）。
//!
//! 为什么放在壳里而不是运行时：DPAPI 是 Win32 API，Node 调它需要原生模块，
//! 会破坏运行时的"零第三方依赖"。
//!
//! 为什么用 DPAPI 而不是"自己拿个密钥加密文件"：
//! 自己加密只能防"误拷贝"，防不住"同用户的其它进程"——它们也能读到那个密钥文件，
//! 那叫混淆，不叫加密。DPAPI 的密钥由**当前用户账户**派生，
//! 文件被拷到别的机器、别的用户下都解不开，这才是真防护。

use std::ffi::c_void;

/// 加密失败的原因。
#[derive(Debug)]
pub enum CryptError {
    /// 输入不是合法 UTF-8。
    InvalidInput,
    /// Win32 调用失败。
    Windows(String),
    /// 该平台不支持（只在非 Windows 构建里出现）。
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
}

impl std::fmt::Display for CryptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptError::InvalidInput => write!(f, "输入不是合法的 UTF-8 文本"),
            CryptError::Windows(msg) => write!(f, "Windows 加密接口失败：{msg}"),
            #[cfg_attr(windows, allow(unreachable_patterns))]
            CryptError::Unsupported => write!(f, "当前平台不支持 DPAPI"),
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn to_blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        }
    }

    unsafe fn take_blob(blob: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let slice = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize);
        slice.to_vec()
    }

    fn free(blob: CRYPT_INTEGER_BLOB) {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(blob.pbData as *mut c_void)));
        }
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, CryptError> {
        let input = to_blob(plain);
        let mut output = CRYPT_INTEGER_BLOB::default();

        unsafe {
            CryptProtectData(
                &input,
                None,
                None,
                None,
                None,
                // 不在 UI 线程上弹加密确认框：这是个后台服务。
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
        .map_err(|error| CryptError::Windows(error.message()))?;

        let bytes = unsafe { take_blob(&output) };
        free(output);
        Ok(bytes)
    }

    pub fn unprotect(cipher: &[u8]) -> Result<Vec<u8>, CryptError> {
        let input = to_blob(cipher);
        let mut output = CRYPT_INTEGER_BLOB::default();

        unsafe {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
        .map_err(|error| CryptError::Windows(error.message()))?;

        let bytes = unsafe { take_blob(&output) };
        free(output);
        Ok(bytes)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn protect(_plain: &[u8]) -> Result<Vec<u8>, CryptError> {
        Err(CryptError::Unsupported)
    }

    pub fn unprotect(_cipher: &[u8]) -> Result<Vec<u8>, CryptError> {
        Err(CryptError::Unsupported)
    }
}

/// 把明文加密成 base64 串。
pub fn encrypt(plain: &str) -> Result<String, CryptError> {
    let bytes = imp::protect(plain.as_bytes())?;
    Ok(base64_encode(&bytes))
}

/// 把 base64 串解密回明文。
pub fn decrypt(encoded: &str) -> Result<String, CryptError> {
    let bytes = base64_decode(encoded).ok_or(CryptError::InvalidInput)?;
    let plain = imp::unprotect(&bytes)?;
    String::from_utf8(plain).map_err(|_| CryptError::InvalidInput)
}

// 只需要标准 base64，不想为此引入依赖，手写十行。
const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn base64_decode(input: &str) -> Option<Vec<u8>> {
    let mut values = Vec::with_capacity(input.len());
    for byte in input.bytes() {
        if byte == b'=' {
            break;
        }
        let value = ALPHABET.iter().position(|&c| c == byte)?;
        values.push(value as u32);
    }

    let mut out = Vec::with_capacity(values.len() * 3 / 4);
    for chunk in values.chunks(4) {
        if chunk.len() < 2 {
            return None;
        }
        let mut n = 0u32;
        for (i, value) in chunk.iter().enumerate() {
            n |= value << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip() {
        for sample in ["", "a", "ab", "abc", "abcd", "密钥测试"] {
            let encoded = base64_encode(sample.as_bytes());
            let decoded = base64_decode(&encoded).expect("解码失败");
            assert_eq!(decoded, sample.as_bytes(), "样本：{sample}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip() {
        let secret = "sk-test-1234567890";
        let cipher = encrypt(secret).expect("加密失败");
        assert_ne!(cipher, secret, "密文不能等于明文");
        assert_eq!(decrypt(&cipher).expect("解密失败"), secret);
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_rejects_garbage() {
        assert!(decrypt("这不是合法的base64!!!").is_err());
        // 合法 base64 但不是 DPAPI 密文
        assert!(decrypt("aGVsbG8=").is_err());
    }
}
