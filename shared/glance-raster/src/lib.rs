//! Fixed, in-process SVG rasterizer shared with resvg-js 2.6.2.
//! Inputs are internal generated SVG and a length-prefixed bundled font list.
use resvg::{tiny_skia, usvg::{self, TreeParsing, TreeTextToPath}};
use std::slice;

/// All buffers are borrowed for this call. Returns zero on failure; no Rust
/// allocation crosses the ABI. Width/height and output capacity are checked.
#[no_mangle]
pub unsafe extern "C" fn agentdeck_glance_rgba(
    svg: *const u8, svg_len: usize, fonts: *const u8, fonts_len: usize,
    width: u32, height: u32, output: *mut u8, output_len: usize,
) -> bool {
    if svg.is_null() || fonts.is_null() || output.is_null() || width == 0 || height == 0
        || width > 1600 || height > 1600 || output_len != width as usize * height as usize * 4 { return false; }
    let mut db = usvg::fontdb::Database::new();
    let mut rest = slice::from_raw_parts(fonts, fonts_len);
    while !rest.is_empty() {
        if rest.len() < 4 { return false; }
        let size = u32::from_le_bytes(rest[..4].try_into().unwrap()) as usize;
        rest = &rest[4..];
        if size > rest.len() { return false; }
        db.load_font_data(rest[..size].to_vec()); rest = &rest[size..];
    }
    let mut options = usvg::Options::default();
    options.font_family = "IBM Plex Sans".into();
    // Generated Glance SVG contains no images. Deny filesystem/URL resolving.
    options.image_href_resolver.resolve_string = std::sync::Arc::new(|_, _| None);
    options.image_href_resolver.resolve_data = std::sync::Arc::new(|_, _, _| None);
    let Ok(mut tree) = usvg::Tree::from_data(slice::from_raw_parts(svg, svg_len), &options) else { return false; };
    if tree.size.width() != width as f32 || tree.size.height() != height as f32 { return false; }
    tree.convert_text(&db);
    let Some(mut pixmap) = tiny_skia::Pixmap::new(width, height) else { return false; };
    resvg::Tree::from_usvg(&tree).render(tiny_skia::Transform::identity(), &mut pixmap.as_mut());
    slice::from_raw_parts_mut(output, output_len).copy_from_slice(pixmap.data());
    true
}
