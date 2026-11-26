import { api, ProfileInfo } from "./api";
import { flushAllSaves } from "./hooks";

/** Set before the reload that follows adding a profile: the new profile then starts its Google login. */
export const LOGIN_NEW_PROFILE = "sm-login-new-profile";

export function profileLabel(p: ProfileInfo) {
  return p.email ?? (p.default ? "기본 프로필" : "새 프로필");
}

/**
 * Pending edits are written into the current profile first; after the switch
 * the whole screen starts over on the other profile's data (nothing on screen
 * may carry over into it).
 */
export async function switchProfile(id: string) {
  await flushAllSaves();
  await api.profileSwitch(id);
  location.hash = "#/";
  location.reload();
}

/** A new, empty profile; it opens on the Google login for its account. */
export async function addProfile() {
  await flushAllSaves();
  await api.profileAdd();
  try {
    sessionStorage.setItem(LOGIN_NEW_PROFILE, "1");
  } catch {
    /* the login button is right there anyway */
  }
  location.hash = "#/settings#sync";
  location.reload();
}
