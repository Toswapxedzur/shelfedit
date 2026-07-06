import Foundation
import SQLite3

enum DatabaseError: Error, LocalizedError {
    case openFailed(String)
    case queryFailed(String)
    case decodeFailed(String)
    case missingProject

    var errorDescription: String? {
        switch self {
        case .openFailed(let message): "Open database failed: \(message)"
        case .queryFailed(let message): "Database query failed: \(message)"
        case .decodeFailed(let message): "Timeline decode failed: \(message)"
        case .missingProject: "No ShelfEdit project found"
        }
    }
}

final class ShelfDatabase {
    private let path: String

    init(path: String = "\(NSHomeDirectory())/.local_ai_video_editor/shelfedit.db") {
        self.path = path
    }

    func listProjects() throws -> [ProjectSummary] {
        try withDB { db in
            let sql = """
            SELECT p.id, p.name, p.updated_at,
                   (SELECT COUNT(*) FROM media_assets m
                    WHERE m.project_id = p.id AND m.type != 'export') AS media_count
            FROM projects p
            WHERE p.deleted_at IS NULL
            ORDER BY p.updated_at DESC
            """
            return try query(db, sql: sql) { stmt in
                ProjectSummary(
                    id: text(stmt, 0),
                    name: text(stmt, 1),
                    updatedAt: text(stmt, 2),
                    mediaCount: Int(sqlite3_column_int(stmt, 3))
                )
            }
        }
    }

    func loadProject(id explicitId: String? = nil) throws -> LoadedProject {
        let projects = try listProjects()
        guard let summary = explicitId.flatMap({ id in projects.first { $0.id == id } }) ?? projects.first else {
            throw DatabaseError.missingProject
        }

        return try withDB { db in
            let mediaRows = try query(
                db,
                sql: """
                SELECT id, project_id, type, original_filename, local_path,
                       duration_seconds, width, height
                FROM media_assets
                WHERE project_id = ? AND type != 'export'
                """,
                binds: [summary.id]
            ) { stmt in
                MediaAsset(
                    id: text(stmt, 0),
                    projectId: text(stmt, 1),
                    type: text(stmt, 2),
                    originalFilename: text(stmt, 3),
                    localPath: text(stmt, 4),
                    duration: sqlite3_column_double(stmt, 5),
                    width: Int(sqlite3_column_int(stmt, 6)),
                    height: Int(sqlite3_column_int(stmt, 7))
                )
            }
            let media = Dictionary(uniqueKeysWithValues: mediaRows.map { ($0.id, $0) })

            let jsonRows = try query(
                db,
                sql: "SELECT data_json FROM timelines WHERE project_id = ? ORDER BY version DESC LIMIT 1",
                binds: [summary.id]
            ) { stmt in text(stmt, 0) }

            let timeline: TimelineData
            if let json = jsonRows.first, !json.isEmpty {
                do {
                    timeline = try JSONDecoder().decode(TimelineData.self, from: Data(json.utf8))
                } catch {
                    throw DatabaseError.decodeFailed(error.localizedDescription)
                }
            } else {
                timeline = .empty()
            }
            return LoadedProject(summary: summary, media: media, timeline: timeline)
        }
    }

    func saveTimeline(projectId: String, timeline: TimelineData) throws {
        let data = try JSONEncoder().encode(timeline)
        guard let json = String(data: data, encoding: .utf8) else {
            throw DatabaseError.decodeFailed("Could not encode JSON")
        }
        try withDB { db in
            let ids = try query(
                db,
                sql: "SELECT id FROM timelines WHERE project_id = ? ORDER BY version DESC LIMIT 1",
                binds: [projectId]
            ) { stmt in text(stmt, 0) }

            if let id = ids.first {
                try execute(db, sql: "UPDATE timelines SET data_json = ? WHERE id = ?", binds: [json, id])
            } else {
                try execute(
                    db,
                    sql: """
                    INSERT INTO timelines (id, project_id, version, data_json, created_at)
                    VALUES (?, ?, 1, ?, datetime('now'))
                    """,
                    binds: [UUID().uuidString.replacingOccurrences(of: "-", with: ""), projectId, json]
                )
            }
            try execute(db, sql: "UPDATE projects SET updated_at = datetime('now') WHERE id = ?", binds: [projectId])
        }
    }

    private func withDB<T>(_ body: (OpaquePointer) throws -> T) throws -> T {
        var db: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK, let db else {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
            if let db { sqlite3_close(db) }
            throw DatabaseError.openFailed(message)
        }
        sqlite3_busy_timeout(db, 5000)
        defer { sqlite3_close(db) }
        return try body(db)
    }

    private func query<T>(
        _ db: OpaquePointer,
        sql: String,
        binds: [String] = [],
        row: (OpaquePointer) throws -> T
    ) throws -> [T] {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw DatabaseError.queryFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        try bind(stmt, binds)

        var result: [T] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_ROW {
                result.append(try row(stmt))
            } else if rc == SQLITE_DONE {
                return result
            } else {
                throw DatabaseError.queryFailed(String(cString: sqlite3_errmsg(db)))
            }
        }
    }

    private func execute(_ db: OpaquePointer, sql: String, binds: [String]) throws {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw DatabaseError.queryFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        try bind(stmt, binds)
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.queryFailed(String(cString: sqlite3_errmsg(db)))
        }
    }

    private func bind(_ stmt: OpaquePointer, _ values: [String]) throws {
        for (index, value) in values.enumerated() {
            guard sqlite3_bind_text(stmt, Int32(index + 1), value, -1, SQLITE_TRANSIENT) == SQLITE_OK else {
                throw DatabaseError.queryFailed("Could not bind value")
            }
        }
    }

    private func text(_ stmt: OpaquePointer, _ index: Int32) -> String {
        guard let c = sqlite3_column_text(stmt, index) else { return "" }
        return String(cString: c)
    }
}

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
