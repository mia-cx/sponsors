# Changesets

Every pull request that changes the service needs a changeset: run `pnpm changeset`, pick a bump, and describe the change.
Merging to `main` collects pending changesets into a version pull request; merging that pull request deploys sponsors.mia.cx.
