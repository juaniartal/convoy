/** GitHub always generates App private keys in this exact format. Anything
 * else — an SSH key someone already has lying around, a key pasted from the
 * wrong place — will "work" as far as env-var loading is concerned and then
 * fail confusingly deep inside Probot's own auth code, which (from watching
 * this happen live) manifests as an unexplained bounce back to the /probot
 * setup screen instead of a clear error. Catch it at the boundary instead. */
export function looksLikeGithubAppPrivateKey(pem: string): boolean {
  return pem.trim().startsWith('-----BEGIN RSA PRIVATE KEY-----');
}
