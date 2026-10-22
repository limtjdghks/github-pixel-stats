# Privacy

This page describes the data the hosted GitHub Pixel Stats service collects, where it is stored, how long it is kept, and how to have it removed.

Contact: **epaktldk0203@gmail.com** (service operator)

## What is collected

The service collects data only when someone requests a card URL that contains a GitHub username. Anyone can request a card for any public GitHub account; no sign-up or consent step exists.

The collector reads public data from the GitHub API with the operator's own read-only token:

- the account's login name;
- commits authored by the account in public repositories during the last 12 months, limited to each repository's default branch: repository ID and name, commit SHA, author date, and the languages of the changed files (classified from file names);
- the number of public repositories the account owns and the stars on the owned repositories that are not forks.

It never collects private repositories, private contributions, email addresses, or profile details beyond the login name. It sets no cookies and does not track people who view the cards. You never give the service a token or password.

## Where it is stored

The service runs on Vercel. Card Functions run in Vercel's `iad1` region (Washington, D.C., USA).

| Data | Storage | Who can read it |
| --- | --- | --- |
| Rendered SVG cards | Public Vercel Blob store | Anyone with the card URL |
| Collected commits, aggregated statistics and in-progress collection state (which may briefly include the paths of changed files) | Private Vercel Blob store | Service operator |
| Registration record: requested usernames, registration time, and failure or removal times | Private Vercel Blob store | Service operator |
| Daily usage counters (operation counts only, no usernames) | Private Vercel Blob store | Service operator |

The service does not intentionally log usernames or tokens; whether error messages from the storage layer can contain them is being checked before launch. Vercel's platform request logs record request URLs, which include the username in the card path; those logs are kept according to Vercel's log retention for the project's plan.

## How long it is kept

- **Published cards:** updated automatically and kept until the account owner asks for removal. The previous version of a card is kept as a fallback and replaced on the next update.
- **Usernames that fail to collect** (for example, accounts that do not exist): retried daily and deleted by the first daily cleanup after 7 days from the first failure.
- **Removed usernames:** after a removal request, only the username with its registration and removal times stays in the registration record, so that the username is not collected again. They are deleted if the owner asks for the cards back.
- **Daily usage counters:** about 90 days.
- **Cached copies:** the service's CDN may keep a card for up to 12 hours after it changes or is removed, plus one stale response. Browsers and GitHub's image proxy may keep a copy for a short time.
- **Removal request emails:** deleted within 30 days after the request is completed, or within 30 days after the last message if it is not completed.

## Removing your data

Only the owner of a personal GitHub account can have its data removed. Ownership is checked with a token that you publish in a gist from the account, so the request itself stays private.

1. Email the contact address above with the subject `GitHub Pixel Stats removal: <username>`.
2. The operator replies with a one-time verification token. It is valid for 7 days.
3. While signed in as `<username>`, create a **public gist** that contains the token, and reply with its link. Files in repositories are not accepted, because other people can add files to a repository.
4. The operator checks that the gist is owned by `<username>` and contains the token, deletes the stored commits, statistics and cards, and keeps only a removal mark for the username. A removed username shows the REMOVED card and is not collected again, even if someone requests its URL.
5. The operator confirms by email. You can delete the gist after that.

After removal:

- Remove the card URLs from your README yourself; the service cannot edit your repositories.
- Cached copies may stay visible for a while; see [How long it is kept](#how-long-it-is-kept).
- If you want the cards back, email the contact address and verify ownership the same way. The operator clears the removal mark, and the username is collected again within the usual new-user limits.

If the GitHub account no longer exists, the operator removes the data without the ownership check. If you cannot sign in to the account, ownership cannot be verified and the request cannot be processed. Organization accounts cannot create gists, so this flow cannot verify them and they are not removed through it.

## Changes

Changes to this page are tracked in the repository's history.
