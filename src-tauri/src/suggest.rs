/// YouTube's search-box suggestions. The `youtube` client answers with JSONP:
/// `window.google.ac.h(["query",[["suggestion",0,[...]],...],{...}])`.
pub fn suggest(query: &str) -> Result<Vec<String>, String> {
    let body = ureq::get("https://suggestqueries-clients6.youtube.com/complete/search")
        .query("client", "youtube")
        .query("ds", "yt")
        .query("q", query)
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())?;
    Ok(parse(&body))
}

pub fn parse(body: &str) -> Vec<String> {
    let json = body
        .find('(')
        .zip(body.rfind(')'))
        .map(|(start, end)| &body[start + 1..end])
        .unwrap_or_default();
    let value: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    value[1]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item[0].as_str().map(str::to_string))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonp_suggestions() {
        let body = r#"window.google.ac.h(["крузак",[["крузак 200",0,[512]],["крузак 200 bodiev",0,[512]]],{"k":1}])"#;
        assert_eq!(parse(body), ["крузак 200", "крузак 200 bodiev"]);
        assert!(parse("<html>error</html>").is_empty());
    }
}
