<?php
declare(strict_types=1);

// Allow cross-origin dashboard clients (Electron/Capacitor/Web) to call panel API.
$origin = isset($_SERVER['HTTP_ORIGIN']) ? trim((string)$_SERVER['HTTP_ORIGIN']) : '*';
if ($origin === '') {
    $origin = '*';
}
header('Access-Control-Allow-Origin: ' . $origin);
header('Vary: Origin');
header('Access-Control-Allow-Headers: Content-Type, X-Panel-Key, X-Agent-Token, Authorization, X-Requested-With');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Max-Age: 600');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/db.php';

$action = $_GET['action'] ?? '';
$db = difsync_db();

try {
    switch ($action) {
        case 'agent_pull':
            if (!difsync_agent_auth_ok()) {
                difsync_json_response(['ok' => false, 'error' => 'Unauthorized'], 401);
                exit;
            }
            $body = difsync_read_json_body();
            $agentId = trim((string)($body['agent_id'] ?? ''));
            $agentName = trim((string)($body['agent_name'] ?? $agentId));
            if ($agentId === '') {
                difsync_json_response(['ok' => false, 'error' => 'agent_id is required'], 400);
                exit;
            }

            $agentParams = [
                ':id' => $agentId,
                ':name' => $agentName,
                ':last_seen' => difsync_now(),
                ':last_status' => 'online',
                ':last_ip' => (string)($_SERVER['REMOTE_ADDR'] ?? ''),
            ];

            // Compatibility path for older SQLite builds that do not support
            // INSERT ... ON CONFLICT ... DO UPDATE.
            $update = $db->prepare(
                'UPDATE agents
                 SET name = :name, last_seen = :last_seen, last_status = :last_status, last_ip = :last_ip
                 WHERE id = :id'
            );
            $update->execute($agentParams);
            if ($update->rowCount() === 0) {
                $insert = $db->prepare(
                    'INSERT INTO agents (id, name, last_seen, last_status, last_ip)
                     VALUES (:id, :name, :last_seen, :last_status, :last_ip)'
                );
                $insert->execute($agentParams);
            }

            $select = $db->prepare(
                'SELECT id, target, payload_json
                 FROM commands
                 WHERE agent_id = :agent_id AND status = "queued"
                 ORDER BY id ASC
                 LIMIT 10'
            );
            $select->execute([':agent_id' => $agentId]);
            $rows = $select->fetchAll();

            $commandIds = [];
            $commands = [];
            foreach ($rows as $row) {
                $cid = (int)$row['id'];
                $commandIds[] = $cid;
                $payload = json_decode((string)$row['payload_json'], true);
                $commands[] = [
                    'id' => $cid,
                    'target' => (string)$row['target'],
                    'payload' => is_array($payload) ? $payload : [],
                ];
            }

            if (!empty($commandIds)) {
                $in = implode(',', array_fill(0, count($commandIds), '?'));
                $upd = $db->prepare("UPDATE commands SET status = 'dispatched', dispatched_at = ? WHERE id IN ($in)");
                $params = array_merge([difsync_now()], $commandIds);
                $upd->execute($params);
            }

            difsync_json_response(['ok' => true, 'commands' => $commands]);
            exit;

        case 'agent_ack':
            if (!difsync_agent_auth_ok()) {
                difsync_json_response(['ok' => false, 'error' => 'Unauthorized'], 401);
                exit;
            }
            $body = difsync_read_json_body();
            $agentId = trim((string)($body['agent_id'] ?? ''));
            $commandId = (int)($body['command_id'] ?? 0);
            $success = (bool)($body['success'] ?? false);
            $message = trim((string)($body['message'] ?? ''));
            $details = $body['details'] ?? [];
            if ($agentId === '' || $commandId <= 0) {
                difsync_json_response(['ok' => false, 'error' => 'agent_id and command_id are required'], 400);
                exit;
            }

            $status = $success ? 'done' : 'failed';
            $upd = $db->prepare(
                'UPDATE commands
                 SET status = :status, executed_at = :executed_at, message = :message, result_json = :result_json
                 WHERE id = :id AND agent_id = :agent_id'
            );
            $upd->execute([
                ':status' => $status,
                ':executed_at' => difsync_now(),
                ':message' => $message,
                ':result_json' => json_encode($details, JSON_UNESCAPED_SLASHES),
                ':id' => $commandId,
                ':agent_id' => $agentId,
            ]);

            $agentUpd = $db->prepare(
                'UPDATE agents
                 SET last_seen = :last_seen, last_status = :last_status, last_ip = :last_ip
                 WHERE id = :id'
            );
            $agentUpd->execute([
                ':last_seen' => difsync_now(),
                ':last_status' => $success ? 'ok' : 'error',
                ':last_ip' => (string)($_SERVER['REMOTE_ADDR'] ?? ''),
                ':id' => $agentId,
            ]);

            difsync_json_response(['ok' => true]);
            exit;

        case 'panel_list_agents':
            if (!difsync_panel_auth_ok()) {
                difsync_json_response(['ok' => false, 'error' => 'Unauthorized'], 401);
                exit;
            }
            $rows = $db->query(
                'SELECT id, name, last_seen, last_status, last_ip
                 FROM agents
                 ORDER BY last_seen DESC'
            )->fetchAll();
            difsync_json_response(['ok' => true, 'agents' => $rows]);
            exit;

        case 'panel_list_commands':
            if (!difsync_panel_auth_ok()) {
                difsync_json_response(['ok' => false, 'error' => 'Unauthorized'], 401);
                exit;
            }
            $agentId = trim((string)($_GET['agent_id'] ?? ''));
            if ($agentId !== '') {
                $stmt = $db->prepare(
                    'SELECT id, agent_id, target, payload_json, status, created_at, dispatched_at, executed_at, message
                     FROM commands
                     WHERE agent_id = :agent_id
                     ORDER BY id DESC LIMIT 60'
                );
                $stmt->execute([':agent_id' => $agentId]);
                $rows = $stmt->fetchAll();
            } else {
                $rows = $db->query(
                    'SELECT id, agent_id, target, payload_json, status, created_at, dispatched_at, executed_at, message
                     FROM commands
                     ORDER BY id DESC LIMIT 60'
                )->fetchAll();
            }

            $commands = [];
            foreach ($rows as $row) {
                $payload = json_decode((string)$row['payload_json'], true);
                $commands[] = [
                    'id' => (int)$row['id'],
                    'agent_id' => (string)$row['agent_id'],
                    'target' => (string)$row['target'],
                    'payload' => is_array($payload) ? $payload : [],
                    'status' => (string)$row['status'],
                    'created_at' => (string)$row['created_at'],
                    'dispatched_at' => (string)$row['dispatched_at'],
                    'executed_at' => (string)$row['executed_at'],
                    'message' => (string)$row['message'],
                ];
            }
            difsync_json_response(['ok' => true, 'commands' => $commands]);
            exit;

        case 'panel_send_command':
            if (!difsync_panel_auth_ok()) {
                difsync_json_response(['ok' => false, 'error' => 'Unauthorized'], 401);
                exit;
            }
            $body = difsync_read_json_body();
            $agentId = trim((string)($body['agent_id'] ?? ''));
            $target = trim((string)($body['target'] ?? ''));
            $payload = $body['payload'] ?? [];
            $replacePending = (bool)($body['replace_pending'] ?? false);
            if ($agentId === '' || $target === '') {
                difsync_json_response(['ok' => false, 'error' => 'agent_id and target are required'], 400);
                exit;
            }
            if (!in_array($target, ['scene', 'openrgb', 'govee', 'inventory'], true)) {
                difsync_json_response(['ok' => false, 'error' => 'target must be scene, openrgb, govee, or inventory'], 400);
                exit;
            }
            if (!is_array($payload)) {
                difsync_json_response(['ok' => false, 'error' => 'payload must be an object'], 400);
                exit;
            }

            // Realtime slider drags can enqueue many stale rows. Optionally keep
            // only the latest queued command per target for this agent.
            if ($replacePending && in_array($target, ['scene', 'openrgb', 'govee'], true)) {
                $del = $db->prepare(
                    'DELETE FROM commands
                     WHERE agent_id = :agent_id
                       AND target = :target
                       AND status = "queued"'
                );
                $del->execute([
                    ':agent_id' => $agentId,
                    ':target' => $target,
                ]);
            }

            $stmt = $db->prepare(
                'INSERT INTO commands (agent_id, target, payload_json, status, created_at)
                 VALUES (:agent_id, :target, :payload_json, "queued", :created_at)'
            );
            $stmt->execute([
                ':agent_id' => $agentId,
                ':target' => $target,
                ':payload_json' => json_encode($payload, JSON_UNESCAPED_SLASHES),
                ':created_at' => difsync_now(),
            ]);

            difsync_json_response(['ok' => true, 'command_id' => (int)$db->lastInsertId()]);
            exit;

        case 'panel_get_inventory':
            if (!difsync_panel_auth_ok()) {
                difsync_json_response(['ok' => false, 'error' => 'Unauthorized'], 401);
                exit;
            }

            $agentId = trim((string)($_GET['agent_id'] ?? ''));
            if ($agentId === '') {
                difsync_json_response(['ok' => false, 'error' => 'agent_id is required'], 400);
                exit;
            }

            $autoQueueRaw = strtolower(trim((string)($_GET['auto_queue'] ?? '1')));
            $autoQueue = in_array($autoQueueRaw, ['1', 'true', 'yes', 'on'], true);

            $selectLatest = $db->prepare(
                'SELECT id, status, created_at, executed_at, message, result_json
                 FROM commands
                 WHERE agent_id = :agent_id AND target = "inventory"
                 ORDER BY id DESC
                 LIMIT 1'
            );
            $selectLatest->execute([':agent_id' => $agentId]);
            $latest = $selectLatest->fetch();

            $inventory = ['pc_devices' => [], 'govee_devices' => [], 'probe' => null];
            $pending = false;
            $queued = false;

            if (is_array($latest)) {
                $status = (string)($latest['status'] ?? '');
                if ($status === 'queued' || $status === 'dispatched') {
                    $pending = true;
                }
                if ($status === 'done') {
                    $details = json_decode((string)($latest['result_json'] ?? '{}'), true);
                    if (is_array($details)) {
                        $inv = $details['inventory'] ?? $details;
                        if (is_array($inv)) {
                            $pc = $inv['pc_devices'] ?? [];
                            $gv = $inv['govee_devices'] ?? [];
                            $probe = $inv['probe'] ?? null;
                            $inventory = [
                                'pc_devices' => is_array($pc) ? $pc : [],
                                'govee_devices' => is_array($gv) ? $gv : [],
                                'probe' => $probe,
                            ];
                        }
                    }
                }
            }

            if ($autoQueue && !$pending && (empty($inventory['pc_devices']) && empty($inventory['govee_devices']))) {
                $ins = $db->prepare(
                    'INSERT INTO commands (agent_id, target, payload_json, status, created_at)
                     VALUES (:agent_id, "inventory", :payload_json, "queued", :created_at)'
                );
                $ins->execute([
                    ':agent_id' => $agentId,
                    ':payload_json' => '{}',
                    ':created_at' => difsync_now(),
                ]);
                $queued = true;
                $pending = true;
                $selectLatest->execute([':agent_id' => $agentId]);
                $latest = $selectLatest->fetch();
            }

            difsync_json_response([
                'ok' => true,
                'agent_id' => $agentId,
                'pending' => $pending,
                'queued' => $queued,
                'inventory' => $inventory,
                'latest' => is_array($latest) ? [
                    'id' => (int)($latest['id'] ?? 0),
                    'status' => (string)($latest['status'] ?? ''),
                    'created_at' => (string)($latest['created_at'] ?? ''),
                    'executed_at' => (string)($latest['executed_at'] ?? ''),
                    'message' => (string)($latest['message'] ?? ''),
                ] : null,
            ]);
            exit;

        default:
            difsync_json_response(['ok' => false, 'error' => 'Unknown action'], 404);
            exit;
    }
} catch (Throwable $e) {
    difsync_json_response(['ok' => false, 'error' => $e->getMessage()], 500);
    exit;
}


