use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("tauri: {0}")]
    Tauri(#[from] tauri::Error),
    #[error("{0}")]
    Msg(String),
    /// The Google session is gone or changed (expired, another account, a newer
    /// login). Raised for work of an old session it is stale once a new login
    /// is in place, and is then not shown.
    #[error("{0}")]
    Session(String),
}

impl Error {
    pub fn msg(s: impl Into<String>) -> Self {
        Error::Msg(s.into())
    }
    pub fn session(s: impl Into<String>) -> Self {
        Error::Session(s.into())
    }
}

// Commands return errors to the frontend as plain strings.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
