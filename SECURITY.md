# Security Policy

Convoy is installed as a GitHub App with read access to your organization's
repositories and Actions data, and typically runs inside a company's own
Kubernetes cluster. We take reports of security issues seriously.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, use GitHub's private vulnerability reporting for this repository
(the "Security" tab → "Report a vulnerability"), or email the maintainers
directly if that isn't available. Include:

- A description of the vulnerability and its potential impact
- Steps to reproduce it
- Any relevant logs, payloads, or configuration

You should receive an acknowledgment within a few days. We'll work with you
to understand and address the issue before any public disclosure.

## Supported Versions

Only the latest released version of Convoy receives security fixes.

## Scope Notes

- Convoy's GitHub App requests only `actions: read` and `metadata: read`
  permissions — it cannot read repository contents, write to repositories, or
  modify Actions workflows. If you find a way it could do more than that,
  that's a vulnerability — please report it.
- Convoy does not store credentials in its own database (there is no
  database in v1) — the GitHub App private key and webhook secret are the
  only long-lived secrets, and are expected to be supplied via environment
  variables or a Kubernetes `Secret`, never committed to source control.
