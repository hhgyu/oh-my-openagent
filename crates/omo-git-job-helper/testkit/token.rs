//! Test-only token plumbing (design section 14): the restricted Medium-integrity launcher token and the token
//! facts every receipt records. Integrity is the reliable fact; `TokenElevation` on a restricted token may still
//! read elevated (round-3 note 8).
#![allow(
    dead_code,
    reason = "the launcher image and the test binaries use different subsets"
)]

use std::ffi::c_void;
use std::path::Path;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{GetLastError, GENERIC_ALL, HANDLE};
use windows_sys::Win32::Security::{
    AddAccessAllowedAce, CreateRestrictedToken, CreateWellKnownSid, GetLengthSid,
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, InitializeAcl,
    SetTokenInformation, TokenDefaultDacl, TokenElevation, TokenIntegrityLevel, TokenUser,
    WinBuiltinAdministratorsSid, WinLocalSystemSid, WinMediumLabelSid, ACCESS_ALLOWED_ACE, ACL,
    ACL_REVISION, DISABLE_MAX_PRIVILEGE, SECURITY_MAX_SID_SIZE, SID_AND_ATTRIBUTES,
    TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY, TOKEN_DEFAULT_DACL, TOKEN_DUPLICATE,
    TOKEN_ELEVATION, TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::SystemServices::SE_GROUP_INTEGRITY;
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, GetCurrentProcess, GetExitCodeProcess, OpenProcess, OpenProcessToken,
    WaitForSingleObject, INFINITE, PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    STARTF_USESTDHANDLES, STARTUPINFOW,
};

use super::win::{command_line, wide, Owned};

pub struct Facts {
    pub elevated: bool,
    pub integrity: u32,
}

fn error() -> u32 {
    // SAFETY: reads the calling thread's last-error value.
    unsafe { GetLastError() }
}

fn well_known(kind: i32) -> Result<Vec<u8>, u32> {
    let mut sid = vec![0u8; usize::try_from(SECURITY_MAX_SID_SIZE).unwrap_or(68)];
    let mut size = SECURITY_MAX_SID_SIZE;
    // SAFETY: `sid` is writable for `size` bytes; no domain SID is needed for these builtin types.
    let ok = unsafe { CreateWellKnownSid(kind, null_mut(), sid.as_mut_ptr().cast(), &mut size) };
    if ok == 0 {
        Err(error())
    } else {
        Ok(sid)
    }
}

pub fn restricted_medium_token() -> Result<Owned, String> {
    let mut own = null_mut();
    let access = TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT;
    // SAFETY: the pseudo-handle names this process; `own` receives a new token handle.
    if unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut own) } == 0 {
        return Err(format!("open {}", error()));
    }
    let own = Owned(own);
    let mut admins =
        well_known(WinBuiltinAdministratorsSid).map_err(|code| format!("admins-sid {code}"))?;
    let deny_only = SID_AND_ATTRIBUTES {
        Sid: admins.as_mut_ptr().cast(),
        Attributes: 0,
    };
    let mut restricted = null_mut();
    // SAFETY: one SID_AND_ATTRIBUTES entry backed by `admins`, which outlives the call; no privilege or restricting list.
    let ok = unsafe {
        CreateRestrictedToken(
            own.raw(),
            DISABLE_MAX_PRIVILEGE,
            1,
            &deny_only,
            0,
            null(),
            0,
            null(),
            &mut restricted,
        )
    };
    if ok == 0 {
        return Err(format!("restrict {}", error()));
    }
    let restricted = Owned(restricted);
    let mut medium = well_known(WinMediumLabelSid).map_err(|code| format!("medium-sid {code}"))?;
    let label = TOKEN_MANDATORY_LABEL {
        Label: SID_AND_ATTRIBUTES {
            Sid: medium.as_mut_ptr().cast(),
            Attributes: SE_GROUP_INTEGRITY.unsigned_abs(),
        },
    };
    // SAFETY: `medium` is a valid SID produced above.
    let sid_length = unsafe { GetLengthSid(medium.as_mut_ptr().cast()) };
    let length =
        u32::try_from(std::mem::size_of::<TOKEN_MANDATORY_LABEL>()).unwrap_or(0) + sid_length;
    let label_ptr: *const c_void = std::ptr::from_ref(&label).cast();
    // SAFETY: `label` points at `medium`, which outlives the call; lowering a token's integrity needs no privilege.
    if unsafe { SetTokenInformation(restricted.raw(), TokenIntegrityLevel, label_ptr, length) } == 0
    {
        return Err(format!("integrity {}", error()));
    }
    standard_default_dacl(&restricted)?;
    Ok(restricted)
}

/// Gives the restricted token the default DACL of a standard user token (the user and SYSTEM get full access).
/// The copied default DACL of an elevated runner grants only Administrators and SYSTEM; with Administrators
/// deny-only, every process the token creates would be closed to the token itself, and a console child's
/// kernelbase init then fails with STATUS_DLL_INIT_FAILED.
fn standard_default_dacl(token: &Owned) -> Result<(), String> {
    let mut user = [0u64; 16];
    let mut returned = 0u32;
    // SAFETY: `user` is 128 aligned bytes, enough for a TOKEN_USER and its SID.
    let ok = unsafe {
        GetTokenInformation(
            token.raw(),
            TokenUser,
            user.as_mut_ptr().cast(),
            128,
            &mut returned,
        )
    };
    if ok == 0 {
        return Err(format!("token-user {}", error()));
    }
    // SAFETY: on success the buffer starts with a TOKEN_USER whose SID lives inside the same buffer.
    let user_sid = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let mut system = well_known(WinLocalSystemSid).map_err(|code| format!("system-sid {code}"))?;
    let sids = [user_sid, system.as_mut_ptr().cast()];
    let ace_base = std::mem::size_of::<ACCESS_ALLOWED_ACE>() - std::mem::size_of::<u32>();
    let mut size = std::mem::size_of::<ACL>();
    for &sid in &sids {
        // SAFETY: both SIDs are valid: one from the token query above, one built by CreateWellKnownSid.
        size += ace_base + usize::try_from(unsafe { GetLengthSid(sid) }).unwrap_or(0);
    }
    let mut acl = vec![0u64; size / 8 + 1];
    let acl_ptr: *mut ACL = acl.as_mut_ptr().cast();
    let acl_size = u32::try_from(size).map_err(|_| "acl-size".to_owned())?;
    // SAFETY: `acl` is at least `acl_size` aligned, writable bytes.
    if unsafe { InitializeAcl(acl_ptr, acl_size, ACL_REVISION) } == 0 {
        return Err(format!("acl {}", error()));
    }
    for &sid in &sids {
        // SAFETY: the ACL was sized for both entries; `sid` outlives the call.
        if unsafe { AddAccessAllowedAce(acl_ptr, ACL_REVISION, GENERIC_ALL, sid) } == 0 {
            return Err(format!("ace {}", error()));
        }
    }
    let dacl = TOKEN_DEFAULT_DACL {
        DefaultDacl: acl_ptr,
    };
    let dacl_ptr: *const c_void = std::ptr::from_ref(&dacl).cast();
    let dacl_size = u32::try_from(std::mem::size_of::<TOKEN_DEFAULT_DACL>()).unwrap_or(0);
    // SAFETY: `dacl` points at `acl`, which outlives the call; the handle carries TOKEN_ADJUST_DEFAULT.
    if unsafe { SetTokenInformation(token.raw(), TokenDefaultDacl, dacl_ptr, dacl_size) } == 0 {
        return Err(format!("default-dacl {}", error()));
    }
    Ok(())
}

pub fn facts(token: HANDLE) -> Facts {
    let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut returned = 0u32;
    let size = u32::try_from(std::mem::size_of::<TOKEN_ELEVATION>()).unwrap_or(0);
    // SAFETY: `elevation` is writable for `size` bytes.
    unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            std::ptr::from_mut(&mut elevation).cast(),
            size,
            &mut returned,
        )
    };
    let mut buffer = [0u64; 16];
    let mut integrity = 0u32;
    // SAFETY: `buffer` is 128 aligned bytes, enough for a TOKEN_MANDATORY_LABEL and its SID.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenIntegrityLevel,
            buffer.as_mut_ptr().cast(),
            128,
            &mut returned,
        )
    };
    if ok != 0 {
        // SAFETY: on success the buffer starts with a TOKEN_MANDATORY_LABEL whose SID lives inside the same buffer.
        unsafe {
            let label = &*buffer.as_ptr().cast::<TOKEN_MANDATORY_LABEL>();
            let count = *GetSidSubAuthorityCount(label.Label.Sid);
            integrity = *GetSidSubAuthority(label.Label.Sid, u32::from(count.saturating_sub(1)));
        }
    }
    Facts {
        elevated: elevation.TokenIsElevated != 0,
        integrity,
    }
}

pub fn process_facts(pid: u32) -> Option<Facts> {
    // SAFETY: plain open by pid; the result is checked before use.
    let process = Owned::new(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
    let mut token = null_mut();
    // SAFETY: `process` is a live handle; `token` receives a new handle.
    if unsafe { OpenProcessToken(process.raw(), TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    let token = Owned(token);
    Some(facts(token.raw()))
}

pub fn run_as(token: &Owned, exe: &Path, args: &[&str]) -> Result<u32, u32> {
    let exe_text = exe.to_string_lossy();
    let mut line_args = vec![exe_text.as_ref()];
    line_args.extend_from_slice(args);
    let application = wide(&exe_text);
    let mut line = wide(&command_line(&line_args));
    // SAFETY: plain C structs for which all-zero is valid.
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = u32::try_from(std::mem::size_of::<STARTUPINFOW>()).unwrap_or(u32::MAX);
    startup.dwFlags = STARTF_USESTDHANDLES;
    // SAFETY: reads this process's standard handles; they are inheritable as the caller's launcher passed them.
    unsafe {
        startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    }
    // SAFETY: as above.
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: both strings are NUL-terminated and outlive the call; a restricted copy of this process's own primary
    // token needs no SeAssignPrimaryTokenPrivilege.
    let ok = unsafe {
        CreateProcessAsUserW(
            token.raw(),
            application.as_ptr(),
            line.as_mut_ptr(),
            null(),
            null(),
            1,
            0,
            null(),
            null(),
            &startup,
            &mut info,
        )
    };
    if ok == 0 {
        return Err(error());
    }
    let process = Owned(info.hProcess);
    drop(Owned(info.hThread));
    let mut code = 0u32;
    // SAFETY: `process` is live; the wait is the launcher's whole job, so it is unbounded by design.
    unsafe {
        WaitForSingleObject(process.raw(), INFINITE);
        GetExitCodeProcess(process.raw(), &mut code);
    }
    Ok(code)
}
