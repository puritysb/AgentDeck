"""Canonical byte RGB uses sRGB; Blender material inputs use scene-linear RGB."""
def linear_rgb(rgb):
    channels = [value / 255 for value in rgb]
    return tuple(value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4
                 for value in channels)
