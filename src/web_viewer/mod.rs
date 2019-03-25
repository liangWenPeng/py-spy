use std::collections::HashMap;
use std::vec::Vec;
use std::sync::{Mutex, Arc};
use std::sync::mpsc::{self, Sender, Receiver};
use std::thread;
use std::time::Instant;
use failure::{Error, ResultExt};

use stack_trace::{StackTrace, Frame};
use mime_guess::guess_mime_type;
use rouille::{Response, Request, Server};
use serde::ser::{Serialize, Serializer, SerializeStruct};

pub struct WebViewer {
    tx: Sender<Message>,
    start: Instant,
    data: Arc<Mutex<Data>>
}

impl WebViewer {
    pub fn new(python_command: &str, version: &str, config: &::config::Config) -> Result<WebViewer, Error> {
        let stats = ProgramStats{gil: Vec::new(), threads: Vec::new(),
                                 python_command: python_command.to_owned(),
                                 version: version.to_owned(),
                                 running: true,
                                 sampling_rate: config.sampling_rate};

        let data = Arc::new(Mutex::new(Data{traces: Vec::new(), trace_ms: Vec::new(), stats}));
        let server_data = data.clone();
        let send_data = data.clone();

        let server = Server::new("0.0.0.0:8000", move |request| http_handler(&server_data.lock().unwrap(), request))
            .map_err(Error::from_boxed_compat)
            .context("Failed to create web server")?;

        thread::spawn(move || {
            println!("Serving requests at http://{}/", server.server_addr());
            server.run();
        });

        let (tx, rx): (Sender<Message>, Receiver<Message>) = mpsc::channel();
        thread::spawn(move || { update_data(rx, send_data); });
        Ok(WebViewer{start: Instant::now(), tx, data})
    }

    pub fn increment(&mut self, traces: Vec<StackTrace>) -> Result<(), Error> {
        let timestamp = Instant::now() - self.start;
        let timestamp_ms = timestamp.as_secs() * 1000 + timestamp.subsec_millis() as u64;
        self.tx.send(Message::Traces(traces, timestamp_ms))?;
        Ok(())
    }

    pub fn notify_exitted(&mut self) {
        self.data.lock().unwrap().stats.running = false;
    }
}

impl Drop for WebViewer {
    fn drop(&mut self) {
        self.tx.send(Message::Terminate).unwrap();
    }
}


#[derive(Debug)]
struct FrameNode {
    count: u64,
    frame: Frame,
    children: HashMap<String, FrameNode>,
    line_numbers: bool
}

impl FrameNode {
    fn new(frame: Frame, line_numbers: bool) -> FrameNode {
        FrameNode{count: 0, frame, children: HashMap::new(), line_numbers}
    }

    fn insert<'a, I>(&mut self, traces: & mut I)
        where I: Iterator<Item = &'a Frame> {
        if let Some(frame) = traces.next() {
            let filename = match &frame.short_filename { Some(f) => &f, None => &frame.filename };
            // TODO: make a member (on stackframe)
            let name = if self.line_numbers && frame.line > 0 {
                format!("{} ({}:{})", frame.name, filename, frame.line)
            } else {
                format!("{} ({})", frame.name, filename)
            };
            let line_numbers = self.line_numbers;
            self.children.entry(name)
                .or_insert_with(|| FrameNode::new(frame.clone(), line_numbers))
                .insert(traces);
        }
        self.count += 1;
    }
}

impl Serialize for FrameNode {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("FrameNode", 4)?;
        state.serialize_field("frame", &self.frame)?;
        let filename = match &self.frame.short_filename { Some(f) => &f, None => &self.frame.filename };
        // TODO: make a member?
        let name = if self.line_numbers && self.frame.line > 0 {
            format!("{} ({}:{})", self.frame.name, filename, self.frame.line)
        } else if filename.len() > 0 {
            format!("{} ({})", self.frame.name, filename)
        } else {
            format!("{}", self.frame.name)
        };
        state.serialize_field("name", &name)?;
        state.serialize_field("value", &self.count)?;

        let children: Vec<&FrameNode> = self.children
            .values()
            // .filter(|f| f.count >= 2)
            .collect();
        state.serialize_field("children", &children)?;
        state.end()
    }
}

fn aggregate_traces(traces: &[StackTrace],
                    include_lines: bool,
                    include_threads: bool,
                    include_idle: bool,
                    only_gil: bool) -> Response {
    let start = Instant::now();
    let mut root = FrameNode::new(Frame{name: "all".to_owned(), filename: "".to_owned(),
                                  short_filename: None, module:None, line: 0}, include_lines);
    for trace in traces {
        if !(include_idle || trace.active) {
            continue;
        }

        if only_gil && !trace.owns_gil {
            continue;
        }

        if include_threads {
            root.children
                .entry(format!("thread 0x{:x}", trace.thread_id))
                .or_insert_with(||
                    FrameNode::new(Frame{name: format!("thread 0x{:x}", trace.thread_id),
                                         filename: "".to_owned(), short_filename: None,
                                         module:None, line: 0}, include_lines))
                .insert(&mut trace.frames.iter().rev());
        } else {
            root.insert(&mut trace.frames.iter().rev());
        }
    }

    let ret = Response::json(&root);
    info!("aggregated {} traces in {:2?}", traces.len(), Instant::now() - start);
    ret
}


#[derive(Debug, Serialize)]
struct ProgramStats {
    // timeseries represented the gil usage (every 100ms)
    gil: Vec<f32>,

    // a bunch of (threadid, timeseries) of activity for each thread (sampled every 100ms)
    threads: Vec<(u64, Vec<f32>)>,

    python_command: String,
    version: String,
    running: bool,
    sampling_rate: u64
}

struct Data {
    traces: Vec<StackTrace>,
    stats: ProgramStats,
    trace_ms: Vec<u64>,
}

enum Message {
    Terminate,
    Traces(Vec<StackTrace>, u64)
}

/// Routes an http request to the appropiate location
fn http_handler(data: &Data, request: &Request) -> Response {
    let start = Instant::now();
    let response = router!(request,
        (GET) (/assets/{filename: String}) => { get_asset(&filename) },
        (GET) (/stats/) => { Response::json(&data.stats) },
        (GET) (/aggregates/{start_time: u64}/{end_time: u64}) => {
            let start = match data.trace_ms.binary_search(&start_time) {
                Ok(v) => v,
                Err(v) => if v > 0 { v - 1 } else { v }
            };

            let end = match data.trace_ms.binary_search(&end_time) {
                Ok(v) => v,
                Err(v) => if v > 0 { v - 1 } else { v }
            };

            let include_lines = request.get_param("include_lines").is_some();
            let include_threads = request.get_param("include_threads").is_some();
            let include_idle = request.get_param("include_idle").is_some();
            let gil_only = request.get_param("gil_only").is_some();

            assert_or_400!(start < data.traces.len() && end < data.traces.len());
            assert_or_400!(end > start);
            aggregate_traces(&data.traces[start..end],
                             include_lines,
                             include_threads,
                             include_idle,
                             gil_only)
        },
        (GET) (/trace/{id: usize}) => {
            assert_or_400!(id < data.traces.len());
            Response::json(&data.traces[id])
        },
        (GET) (/tracecount) => { Response::html(format!("count {}", data.traces.len())) },
        (GET) (/) => { get_asset("index.html") },
        _ =>  { get_404() }
    );

    info!("{} - {} '{}' from {} took {:.2?}", response.status_code, request.method(), request.url(), request.remote_addr(), Instant::now() - start);
    response
}

// we're using rustembed crate to compile everything in the assets folder into the binary
#[derive(RustEmbed)]
#[folder = "src/web_viewer/assets/"]
struct Asset;

// Given a filename (in the assets folder), returns a rouille response with the file
// (or a 404 if it doesn't exist)
fn get_asset(filename: &str) -> Response {
    let mimetype = guess_mime_type(&filename).to_string();
    match Asset::get(&filename) {
        Some(content) => Response::from_data(mimetype, content),
        None => get_404()
    }
}

fn get_404() -> Response {
    match Asset::get("404.html") {
        Some(content) => Response::from_data("text/html", content),
        None => Response::html("404 - not found")
    }.with_status_code(404)
}

fn update_data(rx: Receiver<Message>, send_data: Arc<Mutex<Data>>) {
    let mut current_gil: u64 = 0;
    let mut current: u64 = 0;
    let mut total: u64 = 0;
    let mut threads = HashMap::<u64, u64>::new();
    let mut thread_ids = HashMap::<u64, usize>::new();

    loop {
        match rx.recv().unwrap() {
            Message::Terminate => { return; },
            Message::Traces(traces, timestamp_ms) => {
                for trace in traces {
                    if trace.owns_gil {
                        current_gil += 1;
                    }
                    if trace.active {
                        *threads.entry(trace.thread_id).or_insert(0) += 1;
                    }

                    // if we haven't seen this thread, create new timeseries for it
                    thread_ids.entry(trace.thread_id).or_insert_with(|| {
                        let mut data = send_data.lock().unwrap();
                        let thread_index = data.stats.threads.len();
                        let items = data.stats.gil.len();
                        data.stats.threads.push((trace.thread_id, vec![0.0; items]));
                        thread_index
                    });

                    let mut data = send_data.lock().unwrap();
                    data.traces.push(trace);
                    data.trace_ms.push(timestamp_ms);
                }
                current += 1;

                // Store statistics as a time series, taking a sample every 100ms
                if total <= timestamp_ms  {
                    total += 100;
                    let mut data = send_data.lock().unwrap();
                    for (thread, active) in threads.iter_mut() {
                        let thread_index = thread_ids[thread];
                        data.stats.threads[thread_index].1.push(*active as f32 / current as f32);
                        *active = 0;
                    }
                    data.stats.gil.push(current_gil as f32 / current as f32);
                    current_gil = 0;
                    current = 0;
                }
            }
        }
    }
}
