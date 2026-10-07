<?php
declare(strict_types=1);

// Change these before deploying.
define('DIFSYNC_SYNC_PANEL_KEY', 'change-this-panel-key');
define('DIFSYNC_SYNC_AGENT_TOKEN', 'change-this-agent-token');

// SQLite file location (must be writable by PHP process).
define('DIFSYNC_SYNC_DB_FILE', __DIR__ . '/difsync.sqlite');
