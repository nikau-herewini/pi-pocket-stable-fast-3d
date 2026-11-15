# Security

This is a trusted Pi Pocket drop-in, not a sandbox. Review all runtime files before enabling it.

## Trust boundaries

- Only the owner configures the service URL and timeout. The generation tool cannot select a URL or arbitrary HTTP path. URLs cannot contain credentials, query strings, or fragments.
- Private and loopback endpoints are intentionally allowed for self-hosting. Protect owner access and use HTTPS where appropriate. Redirects are refused.
- Image inputs are limited to current-conversation uploads, recorded Stable Diffusion outputs from that conversation, and its dedicated `<workspace>/.sf3d-inputs/<conversationId>/` folder. Arbitrary workspace files and other conversations' inputs are not accepted.
- A tool hook records successful `sd_generate` result paths and SHA256 hashes in a conversation document, including nested calls. Access to the shared SD output folder alone is insufficient. Recorded SD files must still match their hashes. Outputs generated before this recording was enabled must be copied into the processed-image folder.
- Files are canonicalized and checked for containment. The final file is opened without following symlinks and must be a regular file. Processed-image folder symlinks are rejected. Hostile concurrent changes to parent directories by another local process are outside this boundary; keep the workspace and data volume trusted. Programs with filesystem access can copy files into allowed folders; this is not a sandbox for those programs.
- Inputs are bounded to 10,000,000 bytes and 16,000,000 pixels. PNG/JPEG signatures and dimensions are checked, not full image decoding. Keep the backend and its codecs patched. Validation messages do not expose raw filesystem errors or rejected private paths; the current conversation's processed-image folder can appear as guidance.
- Backend GLB responses are bounded and checked for a valid container. Saved GLBs receive SHA256 integrity checks on replay. These checks are not a complete asset decoder or malware scanner. Use a trusted backend.
- A durable global lock prevents concurrent extension calls. It does not protect against direct backend clients, file replacements, or other installations. Unknown submissions are not repeated automatically; owner recovery is required.
- The owner-only browser settings sheet uses Pi Pocket's settings APIs. The browser contacts Pi Pocket, not the model server, when it saves settings. The module has no public routes or telemetry.

No service is deployed, no account is created, and no model license is granted by this extension. Operators must review their chosen models' terms.

## Reporting

Do not put credentials, private endpoints, prompts, or images in public issues. Use GitHub private vulnerability reporting if enabled. Otherwise, open a minimal issue asking for a private reporting channel without disclosing the vulnerability or private data.
