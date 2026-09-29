#pragma once
#include <cstdint>
using gpio_num_t = int;
constexpr int GPIO_MODE_INPUT_OUTPUT = 3;
struct gpio_config_t { uint64_t pin_bit_mask; int mode; };
inline int gpio_config(const gpio_config_t*) { return 0; }
inline int gpio_set_level(gpio_num_t, int) { return 0; }
inline int gpio_get_level(gpio_num_t) { return 1; }
