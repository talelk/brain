# Backup and restore (demo server)

Nightly (02:30 UTC): an encrypted snapshot of every database and the artifact files goes to a second host; 14 nightly and 8 weekly copies are kept. Monthly: the newest copy is restored into a scratch directory, every database is checked, and the job fails over 30 minutes. Result: `/srv/demos/brain/run/last-restore-test.json`.

Setup (owner): create user `brain-backup` with `/srv/brain-backups` on the backup host and allow the demo server's SSH key; write `BRAIN_BACKUP_HOST=<host>` to `/srv/demos/brain/backup.env` on the server; run `scripts/deploy-demo.sh` (installs the timers); copy `/srv/demos/brain/backup.key` to the password manager (no restore without it).

Restore by hand: check the `.sha256`, `openssl enc -d -aes-256-cbc -pbkdf2 -pass file:backup.key -in <copy> -out payload.tar`, untar, stop the governor, put the databases back in the data volume, start it.

`deploy/demo/maintenance.html` is for the proxy's 502 during a deploy.
