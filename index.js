const Repo = require('./git-tools');
const YAML = require('yaml');
const path = require('path');
const fs = {
  ...require('fs'),
  ...require('fs-extra')
};
const d3Node = require('d3-node');

module.exports = async function() {
  const configPath = path.resolve(process.env.GIT_LOG_CONFIG_PATH || './git-log-config.yml');
  const file = fs.readFileSync(configPath, 'utf8');
  const config = YAML.parse(file);

  console.log(config);

  const repositoriesPath = path.resolve(config.tmpDir);

  fs.ensureDirSync(repositoriesPath);

  const dates = {};

  for (let teamName in config.teams) {
    dates[teamName] = {};
  }

  let usedUsers = [];

  for (let team of config.teams) {
    team.users = team.users || [];
    if (team.invert) {
      team.users = usedUsers;
    } else {
      usedUsers = [...usedUsers, ...team.users];
    }
  }

  for (let repository of config.repositories) {
    const repositoryPath = path.resolve(repositoriesPath, repository.url.replace(/\W+/g, '-').toLowerCase());
    let pathExist = fs.existsSync(repositoryPath);
    let rep = new Repo(repositoryPath);

    if (
      config.cleanTmp ||
      repository.cleanTmp ||
      (pathExist &&
        !(await new Promise((r, e) =>
          rep.isRepo((error, rep) => {
            if (error) {
              e(error);
            } else {
              r(rep);
            }
          })
        )))
    ) {
      fs.removeSync(repositoryPath);
      pathExist = false;
    }

    if (!pathExist) {
      rep = await new Promise((r, e) =>
        Repo.clone(
          {
            repo: repository.url,
            dir: repositoryPath,
            branch: repository.branch || config.branch || 'master'
          },
          (error, rep) => {
            if (error) {
              e(error);
            } else {
              r(rep);
            }
          }
        )
      );
    }

    // rep.authors((error, authors) => {
    //   console.log(authors);
    // });

    for (let teamName in config.teams) {
      const team = config.teams[teamName];
      const activeDays = await createGraph(rep, repository, team, config);
      for (let key in activeDays) {
        dates[teamName][key] = (dates[teamName][key] || 0) + activeDays[key];
      }
    }
  }

  for (let teamName in config.teams) {
    const team = config.teams[teamName];
    // let data = require('./data');
    makeReport(dates[teamName], team, config);
  }
};

async function createGraph(rep, repository, team, config) {
  const branch = repository.branch || config.branch || 'master';
  return await new Promise((r, e) =>
    rep.activeDays(
      branch,
      author => {
        author = author.toLowerCase();
        const includes = team.users.includes(author);
        const exclude = !team.exclude || !team.exclude.includes(author);
        return (team.invert ? !includes : includes) && exclude;
      },
      (error, activeDays) => {
        if (error) {
          e(error);
        } else {
          r(activeDays.dates);
        }
      }
    )
  );
}

function makeReport(dates, team, config) {
  let data = [];

  for (let key in dates) {
    data.push({ Date: key, Value: dates[key] });
  }

  data = data.sort((a, b) => new Date(a.Date) - new Date(b.Date));

  let minYear = 100000;
  let maxYear = 0;

  const checkYear = date => {
    const year = date.getFullYear();

    if (year > maxYear) {
      maxYear = year;
    }

    if (year < minYear) {
      minYear = year;
    }
  };

  const d3n = new d3Node();
  const d3 = d3n.d3;

  const dateValues = data.map(dv => {
    const date = new Date(dv.Date);
    checkYear(date);
    return {
      date: d3.timeDay(date),
      value: Number(dv.Value)
    };
  });

  const yearGap = Math.abs(maxYear - minYear);

  const cellSize = 15;
  const yearHeight = cellSize * 7;
  const marginTop = cellSize * 0.5;
  const marginLeft = 50;
  const marginRight = 10;
  const weeksInYear = 53;

  const [width, height] = [marginLeft + cellSize * (weeksInYear + 1) + marginRight, yearHeight * (yearGap + 1) + 2 * marginTop];
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

  fs.writeFileSync(path.resolve(team.output), d3n.svgString());
}

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
