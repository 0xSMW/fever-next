(function () {
	'use strict';

	// Navigation: mark the link for the section currently in view.
	var masthead = document.querySelector('.masthead');
	var items = [];
	var sections = [];

	Array.prototype.forEach.call(document.querySelectorAll('.nav a'), function (link) {
		var target = document.getElementById(link.hash.slice(1));
		if (!target) return;
		var section = target.closest('.section') || masthead;
		items.push({ link: link, target: target, section: section });
		if (sections.indexOf(section) === -1) sections.push(section);
	});

	function top(element) {
		return element.getBoundingClientRect().top;
	}

	function setActive() {
		var line = Math.min(window.innerHeight / 3, 160);
		var atBottom = window.innerHeight + window.pageYOffset >= document.documentElement.scrollHeight - 2;
		var current = sections[0];

		sections.forEach(function (section) {
			if (top(section) <= line) current = section;
		});
		if (atBottom) current = sections[sections.length - 1];

		var candidates = items.filter(function (item) { return item.section === current; });
		var reached = atBottom ? candidates : candidates.filter(function (item) { return top(item.target) <= line; });
		var pool = reached.length ? reached : candidates;

		// Links that share a target position: prefer the one last followed.
		var chosen = pool.filter(function (item) { return item.link.hash === location.hash; })[0];
		if (!chosen) {
			chosen = pool[0];
			pool.forEach(function (item) {
				if (top(item.target) > top(chosen.target)) chosen = item;
			});
		}

		items.forEach(function (item) {
			var active = item === chosen;
			item.link.classList.toggle('active', active);
			if (active) item.link.setAttribute('aria-current', 'location');
			else item.link.removeAttribute('aria-current');
		});
	}

	var pending = false;
	function scheduleActive() {
		if (pending) return;
		pending = true;
		window.requestAnimationFrame(function () {
			pending = false;
			setActive();
		});
	}

	if (items.length) {
		window.addEventListener('scroll', scheduleActive, { passive: true });
		window.addEventListener('resize', scheduleActive);
		window.addEventListener('hashchange', scheduleActive);
		window.addEventListener('load', scheduleActive);
		setActive();
	}

	// Select the current-time option for the visitor's time zone, as the original page did.
	var offsetSelect = document.getElementById('account_offset');
	if (offsetSelect) {
		var offset = ((new Date()).getTimezoneOffset() / -60) - 1;
		Array.prototype.some.call(offsetSelect.options, function (option) {
			if (Number(option.value) === offset) {
				option.selected = true;
				return true;
			}
			return false;
		});
	}

	// Confirmation fields must match, checked with native constraint validation.
	function requireMatch(confirmId, originalId, message) {
		var confirm = document.getElementById(confirmId);
		var original = document.getElementById(originalId);
		if (!confirm || !original) return;
		function check() {
			confirm.setCustomValidity(confirm.value && confirm.value !== original.value ? message : '');
		}
		confirm.addEventListener('input', check);
		original.addEventListener('input', check);
	}

	requireMatch('account_confirm_email', 'account_email', 'Email addresses do not match.');
	requireMatch('account_confirm_password', 'account_password', 'Passwords do not match.');

	// This copy has no backend. Forms validate natively, then stop here and say so.
	var notSent = {
		create_account_form: 'Not sent. This static recreation has no backend, so accounts cannot be created.',
		login_form: 'Not sent. This static recreation has no backend, so you cannot log in.',
		contact_form: 'Not sent. This static recreation has no backend, so messages cannot be delivered.'
	};

	Object.keys(notSent).forEach(function (id) {
		var form = document.getElementById(id);
		if (!form) return;
		var status = document.getElementById(form.getAttribute('aria-describedby'));
		var button = form.querySelector('button[type="submit"]');

		// Buttons ship disabled so nothing submits without this handler.
		if (button) button.disabled = false;

		form.addEventListener('submit', function (event) {
			event.preventDefault();
			Array.prototype.forEach.call(form.querySelectorAll('input[type="password"]'), function (input) {
				input.value = '';
			});
			if (status) status.textContent = notSent[id];
		});
	});

	// Demo video: report when no playable screencast file is present.
	var video = document.getElementById('screencast');
	var videoStatus = document.getElementById('screencast-status');
	if (video && videoStatus) {
		var sources = video.querySelectorAll('source');
		var showUnavailable = function () {
			videoStatus.textContent = 'The demo video is unavailable in this copy.';
		};
		if (sources.length) sources[sources.length - 1].addEventListener('error', showUnavailable);
		video.addEventListener('error', showUnavailable);
	}
})();
