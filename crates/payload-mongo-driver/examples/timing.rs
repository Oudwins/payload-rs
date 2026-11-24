//! Timing of the driver lane's parts against a real server (development aid):
//!
//!   cargo run --release -p payload-mongo-driver --example timing -- <url> <collection> [plan.json]
//!
//! Prints medians of: a raw `find` (limit 100, sort createdAt desc) iterated without decoding, the
//! same plus `decode_document`, and the full `paginate` lane call (estimated count + find +
//! transform + JSON) with the given plan (default: a plan with no fields).

use std::time::Instant;

use mongodb::bson::{RawDocumentBuf, doc};
use mongodb::options::FindOptions;
use payload_mongo_driver::client::{CountSpec, FindSpec, ReadTarget};
use payload_mongo_driver::value::decode_document;
use payload_mongo_driver::{ConnectSpec, Flags};

const EMPTY_PLAN: &str =
  r#"{"blocks":[],"collections":[],"configBlocks":[],"fields":0,"fieldsArrays":[[]],"flattened":0,"localization":null}"#;

fn median(mut samples: Vec<f64>) -> f64 {
  samples.sort_by(f64::total_cmp);
  samples[samples.len() / 2]
}

fn main() {
  let args: Vec<String> = std::env::args().collect();
  let url = args.get(1).expect("url").clone();
  let collection = args.get(2).expect("collection").clone();
  let plan_text = args.get(3).map(|path| std::fs::read_to_string(path).expect("plan")).unwrap_or(EMPTY_PLAN.into());
  let runtime = payload_mongo_driver::runtime();
  runtime.block_on(async move {
    let info = payload_mongo_driver::connect(&url, ConnectSpec::default()).await.expect("connect");
    let state = payload_mongo_driver::client::client(info.id).expect("client");
    let coll = state.client.database(&info.default_database).collection::<RawDocumentBuf>(&collection);
    let plan = payload_mongo_driver::register_plan(&plan_text).expect("plan");
    let find_options = || {
      let mut options = FindOptions::default();
      options.sort = Some(doc! { "createdAt": -1 });
      options.limit = Some(100);
      options.skip = Some(0);
      options
    };
    for (label, decode) in [("raw find", false), ("find + decode", true)] {
      let mut samples = Vec::new();
      for _ in 0..300 {
        let start = Instant::now();
        let mut cursor = coll.find(doc! {}).with_options(find_options()).await.expect("find");
        let mut n = 0;
        while cursor.advance().await.expect("advance") {
          if decode {
            decode_document(cursor.current()).expect("decode");
          }
          n += 1;
        }
        assert!(n > 0);
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
      }
      println!("{label}: {:.3} ms", median(samples));
    }
    // per-document parts, on 100 prefetched documents
    let mut cursor = coll.find(doc! {}).with_options(find_options()).await.expect("find");
    let mut raws = Vec::new();
    while cursor.advance().await.expect("advance") {
      raws.push(cursor.current().to_raw_document_buf());
    }
    let plan_ref = payload_mongo_driver::client::plan(plan).expect("plan");
    let parts: [(&str, u8); 4] = [("decode", 0), ("decode + transform", 1), ("decode + transform + json", 2), ("raw json only", 3)];
    for (label, part) in parts {
      let mut samples = Vec::new();
      for _ in 0..300 {
        let start = Instant::now();
        let mut out = String::new();
        for raw in &raws {
          if part == 3 {
            payload_mongo_driver::json::write_value(&mut out, &payload_mongo_driver::value::V::RawDoc(raw)).ok();
            continue;
          }
          let mut doc = decode_document(raw).expect("decode");
          if part >= 1 {
            payload_mongo_driver::transform::transform_read(&plan_ref, Flags::default(), payload_mongo_driver::transform::ReadShape { lean_with_id: true }, &mut doc).expect("transform");
          }
          if part >= 2 {
            payload_mongo_driver::json::write_object(&mut out, &doc).expect("json");
          }
        }
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
      }
      println!("{label}: {:.3} ms", median(samples));
    }
    let mut samples = Vec::new();
    for _ in 0..300 {
      let start = Instant::now();
      let target = ReadTarget { client: info.id, collection: collection.clone(), database: None, flags: Flags::default(), plan, txn: None };
      let find = FindSpec {
        filter: doc! {},
        limit: Some(100),
        skip: Some(0),
        sort: Some(doc! { "createdAt": -1 }),
        ..Default::default()
      };
      let text = payload_mongo_driver::paginate(target, CountSpec::Estimated, Some(find)).await.expect("paginate");
      assert!(text.len() > 10);
      samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    println!("paginate lane call: {:.3} ms", median(samples));
  });
}
