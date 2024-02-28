var kaleido = true, keyDown = false;
var segments = 16, strokemultiplier = 5;
var bgcolour = "#FFF";
document.body.style.backgroundColor = bgcolour;

var canvas = document.getElementById("canvas");
var guide = document.getElementById("guide");
var ctx = canvas.getContext("2d");
var guidectx = guide.getContext("2d");
var width = window.innerWidth;
var height = window.innerHeight;

canvas.width = width;
canvas.height = height;
guide.width = width;
guide.height = height;

var ctxprops = {};
var cursor = {};
var currentpoint;

ctx.lineCap = "round";

if ("PointerEvent" in window)
	canvas.addEventListener("pointerdown", onDown);
else if ("TouchEvent" in window)
	canvas.addEventListener("touchstart", onDown);

canvas.addEventListener("mousedown", onDown);

drawGuide(guidectx);

function drawGuide(ctx) {
	ctx.clearRect(0, 0, width, height);
	
	ctx.lineWidth = 1;
	if (bgcolour === "#FFF")
		ctx.strokeStyle = "rgba(0, 0, 0, 1)";
	else
		ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
	
	ctx.lineCap = "round";
	
	ctx.save();
	ctx.beginPath();  
	ctx.translate(width / 2, height / 2);
	
	var r = 360 / segments * Math.PI / 180;
	for (var i = 0; i < segments; ++i) {
		ctx.rotate(r);
		ctx.moveTo(0, 0);
		ctx.lineTo(0, Math.max(width, height) * -1);
	}
	ctx.stroke();
	ctx.restore();
}

function onDown(e) {
	e.stopPropagation();
	e.preventDefault();
	
	if (currentpoint) return;
	
	currentpoint = 1;
	
	if (e.type == "pointerdown") {
		currentpoint = e.pointerId;
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
	}
	else if (e.type == "touchstart") {
		document.addEventListener("touchmove", onMove);
		document.addEventListener("touchend", onUp);
	}
	else {
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	}
	
	if (e.type == "touchstart") {
		cursor.x = cursor.lx = e.touches[0].clientX;
		cursor.y = cursor.ly = e.touches[0].clientY;
	}
	else {
		cursor.x = cursor.lx = e.clientX;
		cursor.y = cursor.ly = e.clientY;
	}
	render();
}

function onMove(e) {
	e.stopPropagation();
	e.preventDefault();
	
	if (e.type == "pointermove") {
		if (currentpoint !== e.pointerId) return;
		ctx.lineWidth = e.pressure * strokemultiplier;
	}
	else
		ctx.lineWidth = strokemultiplier;
	
	if (e.type == "touchmove") {
		cursor.x = e.touches[0].clientX;
		cursor.y = e.touches[0].clientY;
	}
	else {
		cursor.x = e.clientX;
		cursor.y = e.clientY;
	}
	
	render();
	
	cursor.lx = cursor.x;
	cursor.ly = cursor.y;
}

function onUp(e) {
	if (e.type == "pointerup") {
		if (e.pointerId !== currentpoint) return;
		document.removeEventListener("pointermove", onMove);
		document.removeEventListener("pointerup", onUp);
	}
	else if (e.type == "touchend") {
		document.removeEventListener("touchmove", onMove);
		document.removeEventListener("touchend", onUp);
	}
	else {
		document.removeEventListener("mousemove", onMove);
		document.removeEventListener("mouseup", onUp);
	}
	currentpoint = null;
}

function render() {
	var r = 360 / segments * Math.PI / 180;
	for (var i = 0; i < segments; ++i) {
		ctx.save();
		ctx.translate(width / 2, height / 2);
		ctx.rotate(r * i);
		
		if (kaleido)
			if ((segments % 2 === 0) && i > 0 && i % 2 !== 0) {
				ctx.scale(1, -1);
				if (segments % 4 === 0) ctx.rotate(r);
			}
		
		ctx.beginPath();
		ctx.moveTo(cursor.lx - width / 2, cursor.ly - height / 2 - 50);
		ctx.lineTo(cursor.x - width / 2, cursor.y - height / 2 - 50);
		ctx.stroke();
		ctx.restore();
	}
}

$(document).keypress(function(event) {
	if (event.which === 32)
		location.reload();
	if (event.which === 115)
		screenshot();
});

function screenshot() {
	var dataURL = canvas.toDataURL('jpg');
	var name = "drawing.jpg";
	var link = document.createElement("a");
	link.download = name;
	link.href = dataURL;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	delete link;
}

function update(jscolor) {
	ctx.strokeStyle = jscolor.toHEXString();
}