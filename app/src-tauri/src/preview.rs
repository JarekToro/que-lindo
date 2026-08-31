//! preview:// protocol — renders frames with the same compositor as export.
//!
//! URL (via convertFileSrc): the "file path" is a query-ish string
//! `t=<seconds>&s=<scale>&rev=<revision>`, percent-encoded by the frontend.

use slideshow_core::{Ffmpeg, Project, Renderer, Timeline};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::UriSchemeResponder;

#[allow(dead_code)]
pub struct CurrentDoc {
    pub rev: u64,
    pub project: Arc<Project>,
    pub timeline: Arc<Timeline>,
}

pub struct Job {
    pub time: f64,
    pub scale: f32,
    pub responder: UriSchemeResponder,
}

pub fn handle_request(
    tx: &crate::crossbeam_channel_like::Sender<Job>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let raw = percent_decode(request.uri().path().trim_start_matches('/'));
    let mut time = 0.0f64;
    let mut scale = 0.5f32;
    for pair in raw.split('&') {
        match pair.split_once('=') {
            Some(("t", v)) => time = v.parse().unwrap_or(0.0),
            Some(("s", v)) => scale = v.parse().unwrap_or(0.5),
            _ => {}
        }
    }
    tx.send(Job { time, scale, responder });
}

pub fn spawn_render_thread(
    rx: Receiver<Job>,
    current: Arc<Mutex<Option<CurrentDoc>>>,
    ffmpeg: Option<Ffmpeg>,
) {
    std::thread::spawn(move || {
        let mut renderer = Renderer::new(ffmpeg);
        while let Ok(job) = rx.recv() {
            let doc = current.lock().unwrap().as_ref().map(|d| (d.project.clone(), d.timeline.clone()));
            let response = match doc {
                None => plain_response(StatusCode::NO_CONTENT, Vec::new(), "text/plain"),
                Some((project, timeline)) => {
                    match renderer.render_frame(&project, &timeline, job.time, job.scale) {
                        Ok(frame) => match frame.encode_png() {
                            Ok(png) => plain_response(StatusCode::OK, png, "image/png"),
                            Err(e) => error_response(&format!("png encode: {e}")),
                        },
                        Err(e) => error_response(&format!("render: {e:#}")),
                    }
                }
            };
            job.responder.respond(response);
        }
    });
}

fn plain_response(status: StatusCode, body: Vec<u8>, mime: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .unwrap()
}

fn error_response(msg: &str) -> Response<Vec<u8>> {
    log::warn!("preview error: {msg}");
    plain_response(StatusCode::INTERNAL_SERVER_ERROR, msg.as_bytes().to_vec(), "text/plain")
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() + 1 && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
