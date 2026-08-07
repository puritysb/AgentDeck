class UlanziUtils {

	/**
	 * 获取表单数据
	 * Returns the value from a form using the form controls name property
	 * @param {Element | string} form
	 * @returns
	 */
	getFormValue(form) {
		if (typeof form === 'string') {
			form = document.querySelector(form);
		}

		const elements = form ? form.elements : '';

		if (!elements) {
			console.error('Could not find form!');
		}

		const formData = new FormData(form);
		let formValue = {};

		formData.forEach((value, key) => {
			if (!Reflect.has(formValue, key)) {
				formValue[key] = value;
				return;
			}
			if (!Array.isArray(formValue[key])) {
				formValue[key] = [formValue[key]];
			}
			formValue[key].push(value);
		});

		return formValue;
	}

	/**
	 * 重载表单数据
	 * Sets the value of form controls using their name attribute and the jsn object key
	 * @param {*} jsn
	 * @param {Element | string} form
	 */
	setFormValue(jsn, form) {
		if (!jsn) {
			return;
		}

		if (typeof form === 'string') {
			form = document.querySelector(form);
		}

		const elements = form ? form.elements : '';

		if (!elements) {
			console.error('Could not find form!');
		}

		Array.from(elements)
			.filter((element) => element ? element.name : null)
			.forEach((element) => {
				const { name, type } = element;
				const value = name in jsn ? jsn[name] : null;
				const isCheckOrRadio = type === 'checkbox' || type === 'radio';

				if (value === null) return;

				if (isCheckOrRadio) {
					const isSingle = value === element.value;
					console.warn('-----setFormValue isSingle:', isSingle, value, element.value)
					if (isSingle || (Array.isArray(value) && value.includes(element.value))) {
						element.checked = true;
					}
				} else {
					element.value = value ? value : '';
				}
			});
	}

	/**
	 * 延迟触发
	 * This provides a slight delay before processing rapid events
	 * @param {function} fn
	 * @param {number} wait - delay before processing function (recommended time 150ms)
	 * @returns
	 */
	debounce(fn, wait = 150) {
		let timeoutId = null
		return (...args) => {
			window.clearTimeout(timeoutId);
			timeoutId = window.setTimeout(() => {
				fn.apply(null, args);
			}, wait);
		};
	}

	/**
	 * 返回url的查询参数
	*/
	getQueryParams(param) {
		const searchParams = new URLSearchParams(window.location.search);
		return searchParams.get(param);
	}

	/**
	   * 获取浏览器语言
	 * Returns the user language
	*/
	getLanguage() {
		let userLanguage = navigator.languages && navigator.languages.length ? navigator.languages[0] : (navigator.language || navigator.userLanguage);
		if (userLanguage == 'zh') {
			userLanguage = 'zh_CN'
		} else if (userLanguage.indexOf('zh-') >= 0) {
			userLanguage = userLanguage.split('-').join('_')
		} else if (userLanguage.indexOf('-') !== -1) {
			userLanguage = userLanguage.replace(/-/g, '_');
		}
		return this.adaptLanguage(userLanguage);
	}

	/**
	  * 适配语言环境
   */
	adaptLanguage(ln) {
		let userLanguage = ln;
		if (ln.indexOf('zh') == 0) {
			if(ln.indexOf('CN') > -1){
				userLanguage = 'zh_CN'
			}else{
				userLanguage = 'zh_HK'
			}
		} else if (ln.indexOf('en') == 0) {
			userLanguage = 'en'
		} else if (userLanguage.indexOf('-') !== -1) {
			userLanguage = userLanguage.replace(/-/g, '_');
		}

		return userLanguage
	}

	/**
	   * JSON.parse优化
	 * parse json
	 * @param {string} jsonString
	 * @returns {object} json
	*/
	parseJson(jsonString) {
		if (typeof jsonString === 'object') return jsonString;
		try {
			const o = JSON.parse(jsonString);
			if (o && typeof o === 'object') {
				return o;
			}
		} catch (e) { }

		return false;
	}

	/**
	   * 读取json文件
	 * Reads a json file 
	 * @param {string} path
	 * @returns {Promise<any>} json
	*/
	async readJson(path) {
		if (!path) {
			console.error('A path is required to readJson.');
		}

		return new Promise((resolve, reject) => {
			try {
				const req = new XMLHttpRequest();
				req.onerror = reject;
				req.overrideMimeType('application/json');
				req.open('GET', path, true);
				req.onreadystatechange = (response) => {
					if (req.readyState === 4) {
						const jsonString = response && response.target && response.target.response || '';
						if (jsonString) {
							try {
								resolve(JSON.parse(jsonString));
							} catch (e) {
								reject();
							}
						} else {
							reject();
						}
					}
				};

				req.send();

			} catch (e) {
				reject();
			}
		});
	}


	/**
   * 完整图片转base64
   * @param {string} url 图片地址
   * @param {number} width canvas宽度，默认196
   * @param {number} height canvas宽度，默认196
   * @param {HTMLCanvasElement} inCanvas canvas元素，默认创建
   * @param {boolean} returnCanvas 是否返回canvas，默认false。默认返回base64的图片路径，有些时候需要接着画布添加元素，所以我们添加这个变量
	 * @return { string | HTMLCanvasElement }  默认返回base64的图片路径，returnCanvas为true返回画布
   */
	async drawImage(url, width = 196, height = 196, inCanvas, returnCanvas) {
		const canvas = inCanvas && inCanvas instanceof HTMLCanvasElement ? inCanvas : document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');

		const imgData = await this.loadImagePromise(url)
		if (imgData.status == 'ok') {
			ctx.drawImage(imgData.img, 0, 0, canvas.width, canvas.height);
		}
		return returnCanvas ? canvas : canvas.toDataURL('image/png'); //需要是否需要返回画布或者直接返回base64
	}

	/**
   * 裁剪图片转base64
   * @param {string} url 图片地址
   * @param {number} offsetX 裁剪x的位置
   * @param {number} offsetY 裁剪y的位置
   * @param {number} width canvas宽度，默认196
   * @param {number} height canvas宽度，默认196
   * @param {HTMLCanvasElement} inCanvas canvas元素，默认创建
   * @param {boolean} returnCanvas 是否返回canvas，默认false。默认返回base64的图片路径，有些时候需要接着画布添加元素，所以我们添加这个变量
	 * @return { string | HTMLCanvasElement }  默认返回base64的图片路径，returnCanvas为true返回画布
   */
	async cropImage(url, offsetX, offsetY, width = 196, height = 196, inCanvas, returnCanvas) {
		const canvas = inCanvas && inCanvas instanceof HTMLCanvasElement ? inCanvas : document.createElement('canvas');
		const ctx = canvas.getContext('2d');
		canvas.width = width;
		canvas.height = height;


		const imgData = await this.loadImagePromise(url)
		if (imgData.status == 'ok') {
			ctx.drawImage(imgData.img, offsetX, offsetY, width, height, 0, 0, canvas.width, canvas.height);
		}

		return returnCanvas ? canvas : canvas.toDataURL('image/png'); //需要是否需要返回画布或者直接返回base64

	};

	/**
   * 获取图片数据
   * @param {string} url 图片地址
	 * @return {object}  {url, status: 'ok', img} or {url, status: 'error'}  
   */
	loadImagePromise(url) {
		return new Promise(resolve => {
			const img = new Image();
			img.onload = () => resolve({ url, status: 'ok', img });
			img.onerror = () => resolve({ url, status: 'error' });
			img.src = url;
		});
	}


	getData(url, param) {

		param = Object.assign(param || {}, Utils.joinTimestamp());

		//若参数有数组，进行特殊拼接
		url = url + '?' + Object.keys(param).map(e => {
			let str = ''
			//判断数组拼接
			if (param[e] instanceof Array) {
				str = param[e].map((item) => {
					return `${e}=${item}`
				}).join('&')
			} else {
				str = `${e}=${param[e]}`
			}
			return str
		}).join('&');
		// console.warn('=====getData url:', url)
		return new Promise(function (resolve, reject) {
			var req = new XMLHttpRequest();

			req.timeout = 1500; // 设置超时时间为 5 秒

			req.ontimeout = function () {
				console.error('Request timed out');
			};

			req.onload = function () {
				// console.warn('=====getData onload:')
				if (req.status === 200) {
					// console.warn('=====getData success:')
					resolve(req.response);
				} else {
					// console.warn('=====getData not 200:')
					reject(Error(req.statusText));
				}
			};

			req.onerror = function () {
				// console.warn('=====getData error:')
				reject(Error('Network Error'));
			};

			req.open('GET', url, true);
			req.send();
		});
	};

	/**
   * 获取接口数据
   * @param {string} url 接口地址
	 * @param {object} param 接口参数
	 * @param {string} method 请求方式：GET/POST/PUT/DELETE
	 * @param {object} headers 请求头
   */
	fetchData(url, param, method = 'GET', headers = {}) {

		if (method.toUpperCase() === 'GET') {
			param = Object.assign(param || {}, Utils.joinTimestamp());

			const tag = url.indexOf('?') >= 0 ? '&':'?'

			//若参数有数组，进行特殊拼接
			url = url + tag + Object.keys(param).map(e => {
				let str = ''
				//判断数组拼接
				if (param[e] instanceof Array) {
					str = param[e].map((item) => {
						return `${e}=${item}`
					}).join('&')
				} else {
					str = `${e}=${param[e]}`
				}
				return str
			}).join('&');
		}

		const opts = {
			cache: 'no-cache',
			headers,
			method: method,
			body: ['GET', 'HEAD'].includes(method)
				? undefined
				: param,
		};
		return new Promise(function (resolve, reject) {
			Utils.fetchWithTimeout(url, opts)
				.then(async (resp) => {
					// console.warn('==fetch success:', url)
					if (!resp) {
						reject(new Error('No Resp'));
					}
					if (!resp.ok) {
						const errData = await resp.json();
						if (errData) {
							reject(errData);
						} else {
							reject(new Error(`{${resp.status}: ${await resp.text()}}`));
						}

					} else {
						resolve(await resp.json());
					}
				})
				.catch((err) => {
					// console.warn('==fetch error:', JSON.stringify(err))	
					reject(err);
				})
		});
	}

	/**
   * 封装fetch请求，设置超时时间
   */
	fetchWithTimeout(url, options = {}) {
		const { timeout = 15000 } = options; // 设置默认超时时间为8000ms
		// console.warn('====fetchWithTimeout timeout:', timeout)

		const controller = new AbortController();
		const id = setTimeout(() => controller.abort(), timeout);


		// console.warn('==fetchWithTimeout:', url, JSON.stringify(options))
		const response = fetch(url, {
			...options,
			signal: controller.signal
		}).then((response) => {
			// console.warn('==fetchWithTimeout success:', JSON.stringify(response))
			clearTimeout(id);
			return response;
		}).catch((error) => {
			// console.warn('==fetchWithTimeout error:', JSON.stringify(error))
			clearTimeout(id);
			throw error;
		});

		return response;

	}

	/**
   * 获取随机时间戳
   */
	joinTimestamp() {
		const now = new Date().getTime();
		return { _t: now };
	}


	//判断是否为文件类型
	isFile(variable) {
		return variable instanceof File;
	}

	/**
   * 浏览器file转base64
   */
	htmlFileToBase64(file) {
		if (!this.isFile(file)) {
			return Promise.reject(new Error('Not a file'));
		}
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.readAsDataURL(file);
			reader.onload = () => resolve(reader.result);
			reader.onerror = error => reject(error);
		});
	}

	drawText(text, stroke = "#fff", background = "#000", wh = 196, textLabel, inCanvas) {
		// console.log('==drawText:', text, textLabel)
		const canvas = inCanvas ? inCanvas : document.createElement('canvas');
		const ctx = canvas.getContext('2d');
		
		if(!inCanvas){
			canvas.width = wh;
			canvas.height = wh;
			if (background == "transparent") {
				ctx.clearRect(0, 0, canvas.width, canvas.height);
			} else {
				ctx.fillStyle = background;
				ctx.fillRect(0, 0, canvas.width, canvas.height);
			}

		}
	
		
		const font = `"Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`;
		const fSize = text.length > 6 ? 40 : 50;


		// ctx.strokeStyle = "#000";
		// ctx.lineWidth = 4;
		
		ctx.fillStyle = stroke;
		ctx.font = `bold ${fSize}px ${font}`;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'center';

		ctx.strokeText(text, ctx.canvas.width / 2, ctx.canvas.height / 2);
		ctx.fillText(text, ctx.canvas.width / 2, ctx.canvas.height / 2 );
	
		if(textLabel){
			ctx.font = `bold 24px ${font}`;
			ctx.textBaseline = 'middle';
			ctx.textAlign = 'left';
			ctx.fillText(textLabel, 10, 20);
		}
		
		
		return canvas.toDataURL('image/png')
	}

	getProperty(obj, dotSeparatedKeys, defaultValue) {
		if (arguments.length > 1 && typeof dotSeparatedKeys !== 'string') return undefined;
		if (typeof obj !== 'undefined' && typeof dotSeparatedKeys === 'string') {
			const pathArr = dotSeparatedKeys.split('.');
			pathArr.forEach((key, idx, arr) => {
				if (typeof key === 'string' && key.includes('[')) {
					try {
						// extract the array index as string
						const pos = /\[([^)]+)\]/.exec(key)[1];
						// get the index string length (i.e. '21'.length === 2)
						const posLen = pos.length;
						arr.splice(idx + 1, 0, Number(pos));

						// keep the key (array name) without the index comprehension:
						// (i.e. key without [] (string of length 2)
						// and the length of the index (posLen))
						arr[idx] = key.slice(0, -2 - posLen); // eslint-disable-line no-param-reassign
					} catch (e) {
						// do nothing
					}
				}
			});
			// eslint-disable-next-line no-param-reassign, no-confusing-arrow
			obj = pathArr.reduce((o, key) => (o && o[key] !== 'undefined' ? o[key] : undefined), obj);
		}
		return obj === undefined ? defaultValue : obj;
	};

	getProp(jsn, str, defaultValue = {}, sep = '.') {
		const arr = str.split(sep);
		return arr.reduce((obj, key) => (obj && obj.hasOwnProperty(key) ? obj[key] : defaultValue), jsn);
	};

	/**
   * 获取插件根目录路径
   */
	getPluginPath(){
		const currentFilePath = location.pathname;
		let split_tag = '/'
		if(currentFilePath.indexOf('\\') > -1){
			split_tag = '\\'
		}
		const pathArr = currentFilePath.split(split_tag);
		const idx = pathArr.findIndex(f => f.endsWith('ulanziPlugin'));
		const __folderpath = `${pathArr.slice(0, idx + 1).join("/")}`;
	
		return __folderpath;
	
	}

	/**
	 * Logs a message 
	 * @param {any} msg
	 */
	log(...msg) {
		console.warn(`[${new Date().toLocaleString('zh-CN', { hour12: false })}]`, ...msg);
		// this.getQueryParams('debug') && console.log(`[${new Date().toLocaleString('zh-CN', {hour12: false})}]`, ...msg);
	}

	/**
	 * Logs a warning message 
	 */
	warn(...msg) {
		console.warn(`[${new Date().toLocaleString('zh-CN', { hour12: false })}]`, ...msg);
	}

	/**
	 * Logs an error message
	*/
	error(...msg) {
		console.error(`[${new Date().toLocaleString('zh-CN', { hour12: false })}]`, ...msg);
	}
}

const Utils = new UlanziUtils()