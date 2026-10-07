<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

function difsync_db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $pdo = new PDO('sqlite:' . DIFSYNC_SYNC_DB_FILE);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA journal_mode=WAL;');
    $pdo->exec('PRAGMA busy_timeout=5000;');

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT "",
            last_seen TEXT NOT NULL DEFAULT "",
            last_status TEXT NOT NULL DEFAULT "",
            last_ip TEXT NOT NULL DEFAULT ""
        );'
    );

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS commands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id TEXT NOT NULL,
            target TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT "queued",
            created_at TEXT NOT NULL,
            dispatched_at TEXT NOT NULL DEFAULT "",
            executed_at TEXT NOT NULL DEFAULT "",
            message TEXT NOT NULL DEFAULT "",
            result_json TEXT NOT NULL DEFAULT "{}",
            FOREIGN KEY(agent_id) REFERENCES agents(id)
        );'
    );

    return $pdo;
}

function difsync_now(): string
{
    return gmdate('Y-m-d H:i:s');
}

function difsync_json_response(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
}

function difsync_read_json_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function difsync_panel_auth_ok(): bool
{
    $provided = $_SERVER['HTTP_X_PANEL_KEY'] ?? '';
    return is_string($provided) && hash_equals(DIFSYNC_SYNC_PANEL_KEY, $provided);
}

function difsync_agent_auth_ok(): bool
{
    $provided = $_SERVER['HTTP_X_AGENT_TOKEN'] ?? '';
    return is_string($provided) && hash_equals(DIFSYNC_SYNC_AGENT_TOKEN, $provided);
}
