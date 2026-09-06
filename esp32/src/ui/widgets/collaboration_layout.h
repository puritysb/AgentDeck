#pragma once

// IPS10 presentation-only geometry. No activity weights or progress inference.
// Small value types, no heap allocation; also exercised by the host test.
namespace CollaborationLayout {
struct Rect { int x; int y; int width; int height; };
inline Rect cell(int index, int count, int width, int height) {
    const int columns = width >= 600 && count > 1 ? 2 : 1;
    const int rows = count > 0 ? (count + columns - 1) / columns : 1;
    const int rowHeight = height / rows > 216 ? height / rows : 216;
    const int columnWidth = width / columns;
    return { (index % columns) * columnWidth, (index / columns) * rowHeight,
             columnWidth, rowHeight };
}
}
