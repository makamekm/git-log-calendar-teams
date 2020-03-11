const fs = require('fs');
const d3Node = require('d3-node');
const d3n = new d3Node();
const d3 = d3n.d3

let data = require('./data');
data = data.sort((a, b) => new Date(a.Date) - new Date(b.Date));

let minYear = 10000;
let maxYear = 0;

const dateValues = data.map(dv => {
  const date = new Date(dv.Date);
  const year = date.getFullYear();

  if (year > maxYear) {
    maxYear = year;
  }

  if (year < minYear) {
    minYear = year;
  }

  return {
    date: d3.timeDay(date),
    value: Number(dv.AnswerCount)
  };
});

const yearGap = Math.abs(maxYear - minYear);

const cellSize = 15;
const yearHeight = cellSize * 7;
const marginTop = cellSize * 1.5;
const marginLeft = 50;
const marginRight = 10;

const [ width, height ] = [marginLeft + cellSize * 54 + marginRight, yearHeight * (yearGap + 1) + 2 * marginTop];
const svg = d3n.createSVG(width, height);

const years = d3
  .nest()
  .key(d => d.date.getUTCFullYear())
  .entries(dateValues)
  .reverse();

const values = dateValues.map(c => c.value);
const maxValue = d3.max(values);
const minValue = d3.min(values);

const group = svg.append('g');

const year = group
  .selectAll('g')
  .data(years)
  .join('g')
  .attr('transform', (d, i) => `translate(${marginLeft}, ${yearHeight * i + marginTop})`);

year
  .append('text')
  .attr('x', -5)
  .attr('y', -30)
  .attr('text-anchor', 'end')
  .attr('font-size', 16)
  .attr('font-weight', 550)
  .attr('font-family', 'Arial')
  .attr('transform', 'rotate(270)')
  .text(d => d.key);

const formatDay = d => ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'][d.getUTCDay()];
const countDay = d => d.getUTCDay();
const timeWeek = d3.utcSunday;
const formatDate = d3.utcFormat('%x');
const colorFn = d3.scaleSequential(d3.interpolateBuGn).domain([Math.floor(minValue), Math.ceil(maxValue)]);
const format = d3.format('+.2%');

year
  .append('g')
  .attr('text-anchor', 'end')
  .selectAll('text')
  .data(d3.range(7).map(i => new Date(1995, 0, i)))
  .join('text')
  .attr('x', -5)
  .attr('y', d => (countDay(d) + 0.5) * cellSize)
  .attr('dy', '0.31em')
  .attr('font-size', 12)
  .text(formatDay);

year
  .append('g')
  .selectAll('rect')
  .data(d => d.values)
  .join('rect')
  .attr('width', cellSize - 1.5)
  .attr('height', cellSize - 1.5)
  .attr('x', (d, i) => timeWeek.count(d3.utcYear(d.date), d.date) * cellSize + 10)
  .attr('y', d => countDay(d.date) * cellSize + 0.5)
  .attr('fill', d => colorFn(d.value))
  .append('title')
  .text(d => `${formatDate(d.date)}: ${d.value.toFixed(2)}`);

// const legend = group.append('g').attr('transform', `translate(10, ${years.length * yearHeight + cellSize * 4})`);

const categoriesCount = 10;
const categories = [...Array(categoriesCount)].map((_, i) => {
  const upperBound = (maxValue / categoriesCount) * (i + 1);
  const lowerBound = (maxValue / categoriesCount) * i;

  return {
    upperBound,
    lowerBound,
    color: d3.interpolateBuGn(upperBound / maxValue),
    selected: true
  };
});

fs.writeFileSync('output.svg', d3n.svgString());

// const PDFDocument = require('pdfkit');

// const doc = new PDFDocument();
// const out = fs.createWriteStream('output.pdf');
// doc.pipe(out);

// const content = 'req.body.content';
// doc.y = 300;
// doc.text(content, 50, 50);

// doc.addPage()
//    .fontSize(25)
//    .text('Here is some vector graphics...', 100, 100);

// doc.image('path/to/image.png', {
//   fit: [250, 300],
//   align: 'center',
//   valign: 'center'
// });

// // Draw a triangle
// doc.save()
//    .moveTo(100, 150)
//    .lineTo(100, 250)
//    .lineTo(200, 250)
//    .fill("#FF3300");

// // Apply some transforms and render an SVG path with the 'even-odd' fill rule
// doc.scale(0.6)
//    .translate(470, -380)
//    .path('M 250,75 L 323,301 131,161 369,161 177,301 z')
//    .fill('red', 'even-odd')
//    .restore();

// Add some text with annotations
// doc.addPage()
//    .fillColor("blue")
//    .text('Here is a link!', 100, 100)
//    .underline(100, 100, 160, 27, {color: "#0000FF"})
//    .link(100, 100, 160, 27, 'http://google.com/');

// doc.end();
// out.on('finish', function() {
//   // what you want to do with the file.
// });
