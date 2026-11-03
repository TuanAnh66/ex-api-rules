# Security policy

## Report a vulnerability privately

Please report suspected security vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/TuanAnh66/ex-api-rules/security/advisories/new).
You can also open this repository's **Security and quality → Advisories** page
and select **Report a vulnerability**. A GitHub account is required to submit a
report. Reports submitted through this channel are private to the reporter and
authorized maintainers and advisory collaborators until publication.

Do not disclose vulnerability details, exploit code, or sensitive evidence in
public issues, pull requests, discussions, or commit messages. Use one private
report per vulnerability. Ordinary bugs and feature requests can use public
issues when they contain no security-sensitive information.

If the private reporting form is unavailable, open a public issue asking only
for a private security contact. Do not include affected code, reproduction
steps, impact details, or attachments until a private channel is established.

## What to include

- A short summary and the affected component, version or commit, and platform.
- Preconditions, expected behavior, observed behavior, and potential impact.
- Minimal, safe reproduction steps using sanitized fixtures or mock transports.
- Relevant file locations and sanitized evidence, plus any verification limits.
- Suggested mitigations or a patch, if available, shared through the private
  advisory rather than a public pull request.

Never include credentials, private configuration, account identifiers, live
transaction data, or production journals. Do not access other people's data or
run live account API operations to demonstrate a vulnerability.

## Review and coordinated disclosure

Maintainers will assess the report, request clarification when needed, and
coordinate validation, remediation, regression testing, and disclosure through
the private advisory. A report is not confirmation that a vulnerability exists
or that every version is affected. Please coordinate public disclosure with
maintainers so that affected versions and any available fix can be described
accurately.

Include the exact affected version or commit even if it is an older release.
Support and remediation scope are assessed during triage; this policy does not
promise fixes for every historical version or a fixed response deadline.
